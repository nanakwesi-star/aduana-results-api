const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");

// Read-only overview of who teaches what. Visible to Administrator,
// Head (stored as "headmaster") and Super Administrator only.
router.use(requireAuth, requireRole("administrator", "headmaster", "super_administrator"));

router.get("/", async (req, res, next) => {
  try {
    const { rows: staff } = await pool.query(
      `SELECT id, name, email, phone, role, active
       FROM users
       WHERE role IN ('teacher','administrator','headmaster')
       ORDER BY name`
    );
    const { rows: classes } = await pool.query(
      `SELECT c.id, c.name, c.academic_year, c.form_master_id, u.name AS form_master_name
       FROM classes c
       LEFT JOIN users u ON u.id = c.form_master_id
       ORDER BY c.academic_year DESC, c.name`
    );
    const { rows: assignments } = await pool.query(
      `SELECT sa.class_id, sa.subject, sa.teacher_id, u.name AS teacher_name
       FROM subject_assignments sa
       JOIN users u ON u.id = sa.teacher_id`
    );

    const byClass = {};
    for (const a of assignments) {
      (byClass[a.class_id] ||= []).push({
        subject: a.subject,
        teacher_id: a.teacher_id,
        teacher_name: a.teacher_name,
      });
    }

    res.json({
      staff,
      classes: classes.map((c) => ({ ...c, subjects: byClass[c.id] || [] })),
    });
  } catch (err) { next(err); }
});

module.exports = { router };
