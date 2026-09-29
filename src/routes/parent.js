const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");

router.use(requireAuth, requireRole("parent"));

// Two kinds of parent sign-in exist:
//  1) A full parent account (created by the Admin) linked to children
//     through the parent_students table.
//  2) A "guest" parent who signed in with parent phone + student number.
//     Their token carries guest:true and the id of that ONE student, so
//     they can only ever see that child.

// A parent's own children. Full accounts are scoped strictly by the
// parent_students link; guest parents only ever get their one student.
router.get("/children", async (req, res, next) => {
  try {
    if (req.user.guest) {
      const { rows } = await pool.query(
        `SELECT id, full_name, class, admission_no
         FROM students
         WHERE id = $1 AND approval_status = 'approved'`,
        [req.user.id]
      );
      return res.json(rows);
    }
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
    if (req.user.guest) {
      if (String(req.user.id) !== String(req.params.studentId)) {
        return res.status(403).json({ error: "This student is not linked to your account." });
      }
    } else {
      const { rows: linkRows } = await pool.query(
        `SELECT 1 FROM parent_students WHERE parent_id = $1 AND student_id = $2`,
        [req.user.id, req.params.studentId]
      );
      if (!linkRows[0]) return res.status(403).json({ error: "This student is not linked to your account." });
    }

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
