const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const { pool } = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const { writeAuditLog } = require("../services/auditLog");

// Everything here is Administrator-only. Super Administrator accounts are
// deliberately NOT creatable through this route — that role stays a
// manual, out-of-band decision (same reasoning as the original spec:
// emergency unlock power shouldn't be handed out through a normal form).
router.use(requireAuth, requireRole("administrator"));

// ---------------------------------------------------------------
// Staff accounts
// ---------------------------------------------------------------
router.get("/users", async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, email, role, active, created_at FROM users
       WHERE role IN ('teacher','administrator','headmaster') ORDER BY role, name`
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.post("/users", async (req, res, next) => {
  const { name, email, password, role } = req.body;
  if (!name || !email || !password || !role) {
    return res.status(400).json({ error: "name, email, password, and role are all required." });
  }
  if (!["teacher", "administrator", "headmaster"].includes(role)) {
    return res.status(400).json({ error: "Role must be teacher, administrator, or headmaster." });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters." });
  }
  try {
    const passwordHash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      `INSERT INTO users (name, email, password_hash, role) VALUES ($1,$2,$3,$4)
       RETURNING id, name, email, role, active, created_at`,
      [name, email.toLowerCase().trim(), passwordHash, role]
    );
    const created = rows[0];
    await writeAuditLog(pool, {
      examId: null, user: req.user, action: `Created ${role} staff account for ${name} (${email}).`,
      previousValue: null, newValue: created.id, ip: req.ip, device: req.headers["user-agent"],
    }).catch(() => {}); // best-effort; account creation itself already succeeded above
    res.status(201).json(created);
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "That email is already registered." });
    next(err);
  }
});

router.patch("/users/:id/deactivate", async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `UPDATE users SET active = FALSE WHERE id = $1 RETURNING id, name, email, role`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: "Staff account not found." });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// Permanently removes a staff account. Super Administrator accounts and
// your own currently-signed-in account are protected. Any exams this
// person created (and everything tied to those exams — marks, versions,
// correction requests, notifications, report cards, broadsheets, audit
// entries) are deleted along with them, since none of that can
// meaningfully exist without the exam it belongs to. If deleting still
// fails — e.g. because this person approved or reviewed exams that
// belong to OTHER teachers — that's surfaced as a clear error rather
// than silently breaking someone else's records.
router.delete("/users/:id", async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: targetRows } = await client.query(`SELECT id, name, email, role FROM users WHERE id = $1`, [req.params.id]);
    const target = targetRows[0];
    if (!target) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Staff account not found." }); }
    if (target.role === "super_administrator") {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "Super Administrator accounts cannot be deleted from here." });
    }
    if (target.id === req.user.id) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "You cannot delete your own account while signed in." });
    }

    // Detach this person from classes/subjects they're currently assigned to.
    await client.query(`UPDATE classes SET form_master_id = NULL WHERE form_master_id = $1`, [req.params.id]);
    await client.query(`DELETE FROM subject_assignments WHERE teacher_id = $1`, [req.params.id]);

    // Delete every exam this person created, and everything tied to it.
    const { rows: examRows } = await client.query(`SELECT id FROM exams WHERE teacher_id = $1`, [req.params.id]);
    const examIds = examRows.map((r) => r.id);
    if (examIds.length > 0) {
      await client.query(`DELETE FROM exam_marks WHERE exam_id = ANY($1)`, [examIds]);
      await client.query(`DELETE FROM exam_versions WHERE exam_id = ANY($1)`, [examIds]);
      await client.query(`DELETE FROM correction_requests WHERE exam_id = ANY($1)`, [examIds]);
      await client.query(`DELETE FROM notifications WHERE exam_id = ANY($1)`, [examIds]);
      await client.query(`DELETE FROM report_cards WHERE exam_id = ANY($1)`, [examIds]);
      await client.query(`DELETE FROM broadsheets WHERE exam_id = ANY($1)`, [examIds]);
      await client.query(`DELETE FROM audit_log WHERE exam_id = ANY($1)`, [examIds]);
      await client.query(`DELETE FROM exams WHERE id = ANY($1)`, [examIds]);
    }

    await client.query(`DELETE FROM users WHERE id = $1`, [req.params.id]);

    await client.query("COMMIT");

    await writeAuditLog(pool, {
      examId: null, user: req.user,
      action: `Permanently deleted ${target.role} account: ${target.name} (${target.email}), including ${examIds.length} exam(s) they created.`,
      previousValue: target.id, newValue: null, ip: req.ip, device: req.headers["user-agent"],
    }).catch(() => {});

    res.json({ ok: true, deletedExamCount: examIds.length });
  } catch (err) {
    await client.query("ROLLBACK");
    if (err.code === "23503") {
      return res.status(409).json({
        error: "This account can't be deleted because other records still reference it — for example, they approved or reviewed exams belonging to other teachers. Consider using Deactivate instead, which blocks their login but keeps the school's history intact."
      });
    }
    next(err);
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------
// Classes
// ---------------------------------------------------------------
router.get("/classes", async (req, res, next) => {
  try {
    const { rows: classes } = await pool.query(
      `SELECT c.*, u.name AS form_master_name FROM classes c
       LEFT JOIN users u ON u.id = c.form_master_id ORDER BY c.academic_year DESC, c.name`
    );
    const { rows: assignments } = await pool.query(
      `SELECT sa.class_id, sa.subject, sa.teacher_id, u.name AS teacher_name
       FROM subject_assignments sa JOIN users u ON u.id = sa.teacher_id`
    );
    const byClass = {};
    for (const a of assignments) {
      (byClass[a.class_id] ||= []).push({ subject: a.subject, teacherId: a.teacher_id, teacherName: a.teacher_name });
    }
    res.json(classes.map((c) => ({ ...c, subjectAssignments: byClass[c.id] || [] })));
  } catch (err) { next(err); }
});

router.post("/classes", async (req, res, next) => {
  const { name, academicYear } = req.body;
  if (!name || !academicYear) return res.status(400).json({ error: "name and academicYear are required." });
  try {
    const { rows } = await pool.query(
      `INSERT INTO classes (name, academic_year) VALUES ($1,$2) RETURNING *`,
      [name, Number(academicYear)]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "That class already exists for that academic year." });
    next(err);
  }
});

router.patch("/classes/:id/form-master", async (req, res, next) => {
  const { teacherId } = req.body;
  if (!teacherId) return res.status(400).json({ error: "teacherId is required." });
  try {
    const { rows } = await pool.query(
      `UPDATE classes SET form_master_id = $1 WHERE id = $2 RETURNING *`,
      [teacherId, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: "Class not found." });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// Assign (or reassign) the teacher for one subject within a class.
// Upserts, so re-running this for the same class+subject just swaps
// the teacher rather than erroring on a duplicate.
router.post("/classes/:id/subjects", async (req, res, next) => {
  const { subject, teacherId } = req.body;
  if (!subject || !teacherId) return res.status(400).json({ error: "subject and teacherId are required." });
  try {
    const { rows } = await pool.query(
      `INSERT INTO subject_assignments (class_id, subject, teacher_id) VALUES ($1,$2,$3)
       ON CONFLICT (class_id, subject) DO UPDATE SET teacher_id = EXCLUDED.teacher_id
       RETURNING *`,
      [req.params.id, subject, teacherId]
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

router.delete("/classes/:id/subjects/:subject", async (req, res, next) => {
  try {
    await pool.query(
      `DELETE FROM subject_assignments WHERE class_id = $1 AND subject = $2`,
      [req.params.id, req.params.subject]
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// Permanently deletes a class. Blocked if the class has any exams on
// record — those are real academic history and shouldn't disappear
// silently just because the class row is removed. Delete or reassign
// those exams first if the class genuinely needs to go.
router.delete("/classes/:id", async (req, res, next) => {
  try {
    const { rows: examRows } = await pool.query(`SELECT COUNT(*)::int AS count FROM exams WHERE class_id = $1`, [req.params.id]);
    if (examRows[0].count > 0) {
      return res.status(409).json({ error: `This class has ${examRows[0].count} exam(s) on record and can't be deleted. Remove those exams first if you're sure you want to delete the class.` });
    }

    await pool.query(`DELETE FROM subject_assignments WHERE class_id = $1`, [req.params.id]);
    const { rows } = await pool.query(`DELETE FROM classes WHERE id = $1 RETURNING id, name`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: "Class not found." });

    await writeAuditLog(pool, {
      examId: null, user: req.user, action: `Deleted class ${rows[0].name}.`,
      previousValue: rows[0].id, newValue: null, ip: req.ip, device: req.headers["user-agent"],
    }).catch(() => {});

    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------
// Term settings — the single school-wide "current term," locked so
// only Administrators can move it. Every exam created anywhere in the
// system takes its term/year from here, not from anything a teacher types.
// ---------------------------------------------------------------
router.put("/settings/term", async (req, res, next) => {
  const { term, academicYear } = req.body;
  if (!term || !academicYear) return res.status(400).json({ error: "term and academicYear are required." });
  try {
    const { rows } = await pool.query(
      `UPDATE term_settings SET term = $1, academic_year = $2, updated_by = $3, updated_at = now() WHERE id = 1 RETURNING *`,
      [term, Number(academicYear), req.user.id]
    );
    await writeAuditLog(pool, {
      examId: null, user: req.user, action: `Changed the school's current term to ${term} ${academicYear}.`,
      previousValue: null, newValue: `${term} ${academicYear}`, ip: req.ip, device: req.headers["user-agent"],
    }).catch(() => {});
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------
// Parent accounts — a real login (unlike the old admission-number
// lookup), linked to one or more children via parent_students.
// ---------------------------------------------------------------
router.get("/parents", async (req, res, next) => {
  try {
    const { rows: parents } = await pool.query(
      `SELECT id, name, email, active, created_at FROM users WHERE role = 'parent' ORDER BY name`
    );
    const { rows: links } = await pool.query(
      `SELECT ps.parent_id, s.id AS student_id, s.full_name, s.class, s.admission_no
       FROM parent_students ps JOIN students s ON s.id = ps.student_id`
    );
    const byParent = {};
    for (const l of links) (byParent[l.parent_id] ||= []).push({ studentId: l.student_id, fullName: l.full_name, class: l.class, admissionNo: l.admission_no });
    res.json(parents.map((p) => ({ ...p, children: byParent[p.id] || [] })));
  } catch (err) { next(err); }
});

router.post("/parents", async (req, res, next) => {
  const { name, email, password, admissionNos } = req.body; // admissionNos: string[]
  if (!name || !email || !password) return res.status(400).json({ error: "name, email, and password are required." });
  if (password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters." });

  try {
    const passwordHash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      `INSERT INTO users (name, email, password_hash, role) VALUES ($1,$2,$3,'parent')
       RETURNING id, name, email, role, active, created_at`,
      [name, email.toLowerCase().trim(), passwordHash]
    );
    const parent = rows[0];

    const linked = [];
    const notFound = [];
    for (const admissionNo of admissionNos || []) {
      const { rows: studentRows } = await pool.query(`SELECT id, full_name FROM students WHERE admission_no = $1`, [admissionNo]);
      if (!studentRows[0]) { notFound.push(admissionNo); continue; }
      await pool.query(
        `INSERT INTO parent_students (parent_id, student_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [parent.id, studentRows[0].id]
      );
      linked.push(studentRows[0].full_name);
    }

    await writeAuditLog(pool, {
      examId: null, user: req.user, action: `Created parent account for ${name} (${email}), linked to: ${linked.join(", ") || "no children yet"}.`,
      previousValue: null, newValue: parent.id, ip: req.ip, device: req.headers["user-agent"],
    }).catch(() => {});

    res.status(201).json({ ...parent, linked, notFound });
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "That email is already registered." });
    next(err);
  }
});

router.post("/parents/:id/link-student", async (req, res, next) => {
  const { admissionNo } = req.body;
  if (!admissionNo) return res.status(400).json({ error: "admissionNo is required." });
  try {
    const { rows: studentRows } = await pool.query(`SELECT id, full_name FROM students WHERE admission_no = $1`, [admissionNo]);
    if (!studentRows[0]) return res.status(404).json({ error: "No student found with that admission number." });
    await pool.query(`INSERT INTO parent_students (parent_id, student_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [req.params.id, studentRows[0].id]);
    res.json({ ok: true, linked: studentRows[0].full_name });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------
// Student login credentials — issued separately from admission,
// since a spreadsheet-uploaded student normally starts with no
// login at all until staff explicitly set one up.
// ---------------------------------------------------------------
router.post("/students/:id/set-credentials", async (req, res, next) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "email and password are required." });
  if (password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters." });
  try {
    const passwordHash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      `UPDATE students SET email = $1, password_hash = $2, active = TRUE WHERE id = $3
       RETURNING id, full_name, email, class, admission_no`,
      [email.toLowerCase().trim(), passwordHash, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: "Student not found." });
    await writeAuditLog(pool, {
      examId: null, user: req.user, action: `Issued login credentials to student ${rows[0].full_name} (${email}).`,
      previousValue: null, newValue: rows[0].id, ip: req.ip, device: req.headers["user-agent"],
    }).catch(() => {});
    res.json(rows[0]);
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "That email is already in use." });
    next(err);
  }
});

// Lets an Administrator reset a forgotten password for staff or
// parents — the practical answer to "I forgot my password" without
// any email/SMS reset infrastructure. Deliberately excludes
// super_administrator: that role stays outside normal admin control,
// same reasoning as it being uncreatable through this panel.
router.patch("/users/:id/reset-password", async (req, res, next) => {
  const { newPassword } = req.body;
  if (!newPassword || newPassword.length < 8) return res.status(400).json({ error: "New password must be at least 8 characters." });
  try {
    const { rows: targetRows } = await pool.query(`SELECT role FROM users WHERE id = $1`, [req.params.id]);
    if (!targetRows[0]) return res.status(404).json({ error: "Account not found." });
    if (targetRows[0].role === "super_administrator") return res.status(403).json({ error: "Super Administrator passwords cannot be reset from here." });

    const newHash = await bcrypt.hash(newPassword, 10);
    await pool.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [newHash, req.params.id]);
    await writeAuditLog(pool, {
      examId: null, user: req.user, action: `Reset password for account ${req.params.id}.`,
      previousValue: null, newValue: null, ip: req.ip, device: req.headers["user-agent"],
    }).catch(() => {});
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = { router };
