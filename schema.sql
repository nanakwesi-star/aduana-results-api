-- ============================================================
-- Aduana Model JHS — Results Approval & Final Validation
-- PostgreSQL schema
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto"; -- for gen_random_uuid()

CREATE TYPE user_role AS ENUM ('teacher', 'administrator', 'headmaster', 'super_administrator');

CREATE TYPE exam_status AS ENUM (
  'draft',
  'submitted',
  'admin_returned',
  'admin_approved',
  'hm_returned',
  'published',
  'correction_pending_admin',
  'correction_pending_hm',
  'locked'
);

CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  email         TEXT UNIQUE NOT NULL,
  phone         TEXT,
  password_hash TEXT NOT NULL,
  role          user_role NOT NULL,
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE students (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name       TEXT NOT NULL,
  class           TEXT NOT NULL,               -- e.g. 'JHS 2B'
  admission_no    TEXT UNIQUE NOT NULL,
  parent_phone    TEXT,                        -- for SMS
  parent_whatsapp TEXT,                        -- for WhatsApp
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Every examination record gets a permanent, immutable ID (the UUID itself).
CREATE TABLE exams (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  class                  TEXT NOT NULL,
  subject                TEXT NOT NULL,
  term                   TEXT NOT NULL,
  academic_year          INT  NOT NULL,
  teacher_id             UUID NOT NULL REFERENCES users(id),
  status                 exam_status NOT NULL DEFAULT 'draft',
  current_version        INT NOT NULL DEFAULT 1,
  headmaster_approver_id UUID REFERENCES users(id),
  published_at           TIMESTAMPTZ,
  lock_at                TIMESTAMPTZ,           -- published_at + 21 days
  locked_at              TIMESTAMPTZ,           -- set when the scheduler actually locks it
  emergency_unlocked     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (class, subject, term, academic_year)
);

CREATE INDEX idx_exams_status ON exams(status);
CREATE INDEX idx_exams_lock_at ON exams(lock_at) WHERE status = 'published';

-- Marks are versioned. The "current" marks for an exam are the rows
-- where version = exams.current_version. Older versions are never
-- deleted or overwritten — a correction always INSERTs a new version.
CREATE TABLE exam_marks (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  exam_id     UUID NOT NULL REFERENCES exams(id),
  version     INT NOT NULL,
  student_id  UUID NOT NULL REFERENCES students(id),
  score       NUMERIC(5,2) NOT NULL CHECK (score >= 0 AND score <= 100),
  grade       TEXT,
  remarks     TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (exam_id, version, student_id)
);

-- Metadata about each published/corrected version (who approved what, when).
CREATE TABLE exam_versions (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  exam_id                UUID NOT NULL REFERENCES exams(id),
  version                INT NOT NULL,
  changed_by_user_id     UUID NOT NULL REFERENCES users(id),
  admin_approver_id      UUID REFERENCES users(id),
  headmaster_approver_id UUID REFERENCES users(id),
  note                   TEXT,
  is_correction          BOOLEAN NOT NULL DEFAULT FALSE,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (exam_id, version)
);

-- Formal correction requests during the 21-day window.
CREATE TABLE correction_requests (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  exam_id                     UUID NOT NULL REFERENCES exams(id),
  requested_by_id             UUID NOT NULL REFERENCES users(id),
  reason                      TEXT NOT NULL,
  proposed_marks              JSONB NOT NULL,      -- [{student_id, score}, ...]
  status                      TEXT NOT NULL DEFAULT 'pending_admin'
                                CHECK (status IN ('pending_admin','pending_headmaster','approved','rejected_admin','rejected_headmaster')),
  admin_decided_by            UUID REFERENCES users(id),
  admin_decided_at            TIMESTAMPTZ,
  admin_decision_reason       TEXT,
  headmaster_decided_by       UUID REFERENCES users(id),
  headmaster_decided_at       TIMESTAMPTZ,
  headmaster_decision_reason  TEXT,
  resulting_version           INT,                 -- set once approved
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Emergency unlocks by Super Administrator only.
CREATE TABLE emergency_unlocks (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  exam_id         UUID NOT NULL REFERENCES exams(id),
  super_admin_id  UUID NOT NULL REFERENCES users(id),
  reason          TEXT NOT NULL,
  new_lock_at     TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Generated documents. Regeneration after lock always re-renders from the
-- immutable version snapshot in exam_marks/exam_versions — never from a
-- mutable "current marks" concept — so a locked PDF can never reflect
-- altered marks.
CREATE TABLE report_cards (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  exam_id      UUID NOT NULL REFERENCES exams(id),
  student_id   UUID NOT NULL REFERENCES students(id),
  version      INT NOT NULL,
  file_path    TEXT NOT NULL,
  content_hash TEXT NOT NULL,     -- sha256 of the rendered PDF, embedded in QR
  qr_token     TEXT NOT NULL UNIQUE,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE broadsheets (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  exam_id      UUID NOT NULL REFERENCES exams(id),
  version      INT NOT NULL,
  file_path    TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE notifications (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  exam_id      UUID NOT NULL REFERENCES exams(id),
  student_id   UUID NOT NULL REFERENCES students(id),
  channel      TEXT NOT NULL CHECK (channel IN ('sms','whatsapp')),
  destination  TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','failed')),
  provider_ref TEXT,             -- mNotify message id
  error        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at      TIMESTAMPTZ
);

-- ============================================================
-- Tamper-resistant audit log
-- Hash-chained (each row commits to the previous row's hash) and
-- protected from UPDATE/DELETE at the database level, not just the
-- application level.
-- ============================================================
CREATE TABLE audit_log (
  id              BIGSERIAL PRIMARY KEY,
  exam_id         UUID REFERENCES exams(id),
  user_id         UUID REFERENCES users(id),
  user_name       TEXT NOT NULL,
  user_role       user_role NOT NULL,
  action          TEXT NOT NULL,
  previous_value  TEXT,
  new_value       TEXT,
  reason          TEXT,
  ip_address      INET,
  device_info     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  prev_hash       TEXT NOT NULL,
  row_hash        TEXT NOT NULL
);

CREATE INDEX idx_audit_exam ON audit_log(exam_id);

-- Prevent any modification or deletion of audit rows, even by a superuser
-- role connecting as the app's normal DB user.
CREATE OR REPLACE FUNCTION forbid_audit_mutation() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only: % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_audit_no_update
  BEFORE UPDATE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_audit_mutation();

CREATE TRIGGER trg_audit_no_delete
  BEFORE DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_audit_mutation();

-- Application DB role should have INSERT + SELECT only on audit_log, e.g.:
--   REVOKE UPDATE, DELETE ON audit_log FROM app_user;
--   GRANT INSERT, SELECT ON audit_log TO app_user;
