const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");

router.use(requireAuth, requireRole("parent"));

// A parent's own children, scoped strictly by the parent_students
// link — a parent can never fetch a student they aren't actually
// linked to, no matter what id they try in a later request.
router.get("/children", async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT s.id, s.full_name, s.class, s.admission_no
       FROM parent_students ps JOIN students s ON s.id = ps.student_id
       WHERE ps.parent_id = $1 ORDER BY s.full_name`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.get("/children/:studentId/results", async (req, res, next) => {
  try {
    const { rows: linkRows } = await pool.query(
      `SELECT 1 FROM parent_students WHERE parent_id = $1 AND student_id = $2`,
      [req.user.id, req.params.studentId]
    );
    if (!linkRows[0]) return res.status(403).json({ error: "This student is not linked to your account." });

    const { rows } = await pool.query(
      `SELECT e.subject, e.term, e.academic_year, e.published_at, em.score, em.grade, em.remarks
       FROM exams e JOIN exam_marks em ON em.exam_id = e.id AND em.version = e.current_version
       WHERE em.student_id = $1 AND e.status IN ('published','locked')
       ORDER BY e.academic_year DESC, e.term DESC, e.subject`,
      [req.params.studentId]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

module.exports = { router };
