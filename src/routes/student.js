const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");

router.use(requireAuth, requireRole("student"));

router.get("/me", async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, full_name, class, admission_no, email FROM students WHERE id = $1`, [req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ error: "Student record not found." });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// A student can only ever see their own results — req.user.id comes
// from the verified JWT, never from anything the client supplies, so
// there's no id parameter here to tamper with.
router.get("/results", async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT e.subject, e.term, e.academic_year, e.published_at, em.score, em.grade, em.remarks
       FROM exams e JOIN exam_marks em ON em.exam_id = e.id AND em.version = e.current_version
       WHERE em.student_id = $1 AND e.status IN ('published','locked')
       ORDER BY e.academic_year DESC, e.term DESC, e.subject`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

module.exports = { router };
