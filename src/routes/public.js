const express = require("express");
const router = express.Router();
const { pool } = require("../db");

/**
 * Public lookup by admission number. Deliberately returns only exams that
 * are 'published' or 'locked' — a parent can never see a draft, a
 * submitted-but-unapproved mark, or anything mid-workflow, only the
 * official record. No authentication is required, matching how a real
 * parent portal link works (e.g. from an SMS), but this also means the
 * admission number itself is acting as the access key — worth upgrading
 * to a PIN or date-of-birth check before this handles real student data.
 */
router.get("/students/:admissionNo/results", async (req, res, next) => {
  try {
    const { rows: studentRows } = await pool.query(
      `SELECT * FROM students WHERE admission_no = $1`, [req.params.admissionNo]
    );
    const student = studentRows[0];
    if (!student) return res.status(404).json({ error: "No student found with that admission number." });

    const { rows: results } = await pool.query(
      `SELECT e.id AS exam_id, e.subject, e.term, e.academic_year, e.status, e.published_at,
              em.score, em.grade, em.remarks, em.version
       FROM exams e
       JOIN exam_marks em ON em.exam_id = e.id AND em.version = e.current_version
       WHERE em.student_id = $1 AND e.status IN ('published','locked')
       ORDER BY e.academic_year DESC, e.term DESC, e.subject`,
      [student.id]
    );

    res.json({
      student: { fullName: student.full_name, class: student.class, admissionNo: student.admission_no },
      results,
    });
  } catch (err) { next(err); }
});

module.exports = { router };
