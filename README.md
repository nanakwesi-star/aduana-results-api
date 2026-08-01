# Aduana Model JHS — Results Approval & Final Validation API

A deployable backend for the workflow prototyped earlier: Teacher upload → Administrator
review → Headmaster final validation → Publication → 21-day correction window →
permanent lock → Super Administrator emergency unlock.

## Stack

- **Node.js / Express** — API server
- **PostgreSQL** — source of truth, with DB-level triggers protecting the audit log
- **node-cron** — background job that performs the automatic 21-day lock
- **pdfkit + qrcode** — report card / broadsheet generation with QR verification
- **mNotify (BMS Africa)** — SMS/WhatsApp delivery, reusing sender ID `AduanaModel`

## Setup

```bash
cp .env.example .env        # fill in DATABASE_URL, JWT_SECRET, MNOTIFY_API_KEY, QR_SIGNING_SECRET
npm install
npm run migrate             # applies schema.sql
npm start
```

## How each requirement maps to the code

| Requirement | Where |
|---|---|
| Teacher can edit until submit | `PUT/POST /api/exams/:id/marks`, `/submit` — gated by `status IN ('draft','admin_returned')` and `teacher_id` ownership |
| Admin approve / return with comments | `/api/exams/:id/admin-approve`, `/admin-return` |
| Headmaster approve+publish / return | `/api/exams/:id/hm-return`, `/publish` — only `role = headmaster` can hit `/publish` |
| Publish generates report cards, broadsheets, Parent Portal, notifications, records date + approver | all inside the `/publish` transaction in `routes/exams.js` |
| 21-day correction window, Admin→Headmaster approval, new version preserving old | `/api/exams/:id/corrections`, `/corrections/:id/admin-decision`, `/headmaster-decision` — always **INSERT** a new `exam_marks`/`exam_versions` row, never UPDATE |
| Automatic permanent lock at 21 days | `services/lockScheduler.js` — the *only* code path that sets `status = 'locked'` |
| Lock blocks all edits for every role | `assertLive()` guard called at the top of every mutating route |
| Super Admin emergency unlock, mandatory reason, notifies Headmaster | `routes/superAdmin.js` |
| Tamper-resistant audit log | `services/auditLog.js` (hash chain) + `schema.sql` triggers that reject `UPDATE`/`DELETE` on `audit_log` even at the DB level |
| Audit log restricted to Admin/Headmaster | `requireRole('administrator','headmaster','super_administrator')` on `GET /:id/audit-log` |
| Version history, nothing ever deleted | `exam_versions` + `exam_marks` are append-only by convention (no route ever issues `DELETE` or `UPDATE` on marks rows) |
| QR verification still works after lock; PDFs can't be regenerated with altered marks | `services/pdfGenerator.js` always renders from a specific immutable `version`; `routes/verify.js` re-checks the DB, never trusts the PDF |
| Unique immutable Examination ID | `exams.id` — a UUID, primary key, never reused |

## Notable design decisions worth reviewing with your team

1. **Every state transition writes exactly one audit row inside the same DB transaction** as the change it describes — so it's structurally impossible to change status without logging it.
2. **The lock is enforced three ways**, not just one: (a) the scheduler is the only writer of `status='locked'`, (b) `assertLive()` blocks all mutating routes once locked, (c) the DB triggers make the audit trail itself append-only regardless of what the app does. Any one of these failing doesn't compromise the others.
3. **Corrections never overwrite `exam_marks`** — they insert a new `version`. Report cards and broadsheets are tied to a specific version number, so a version-1 PDF generated before a correction remains byte-identical and verifiable forever, even after version 2 is published.
4. **Notification sending happens after the transaction commits**, not inside it — an mNotify outage should never be able to roll back a publication that already succeeded in the database.

## Still to decide before production

- Auth: this assumes an existing login step issues the JWT; wire up `/api/auth/login` against `users.password_hash` (bcrypt) if you don't already have one.
- File storage: `REPORTS_DIR` currently points at local disk — for 200–500 students you'll likely want to move to S3-compatible storage (e.g. DigitalOcean Spaces, given Ghana hosting options) so PDFs survive a server redeploy.
- The Parent Portal itself (student/parent-facing read views) isn't in this repo — this is the admin/workflow API it would call.
