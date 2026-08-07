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

module.exports = { router };
