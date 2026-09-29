const express = require("express");
const router = express.Router();
const fs = require("fs");
const { pool } = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");

router.use(requireAuth, requireRole("parent"));

// Two kinds of parent sign-in exist:
//  1) A full parent account (created by the Admin) linked to children
//     through the parent_students table.
//  2) A "guest" parent who signed in with parent phone + student number.
//     Their token carries guest:true and the id of that ONE student, so
//     they can only ever see that child.
async function parentCanSeeStudent(req, studentId) {
  if (req.user.guest) return String(req.user.id) === String(studentId);
  const { rows } = await pool.query(
    `SELECT 1 FROM parent_students WHERE parent_id = $1 AND student_id = $2`,
    [req.user.id, studentId]
  );
  return !!rows[0];
}

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
    if (!(await parentCanSeeStudent(req, req.params.studentId))) {
      return res.status(403).json({ error: "This student is not linked to your account." });
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

// Which terminal reports (term + year) exist for this child, so the
// parent screen can show one Download button per report.
router.get("/children/:studentId/reports", async (req, res, next) => {
  try {
    if (!(await parentCanSeeStudent(req, req.params.studentId))) {
      return res.status(403).json({ error: "This student is not linked to your account." });
    }
    const { rows } = await pool.query(
      `SELECT term, academic_year FROM terminal_reports
       WHERE student_id = $1 ORDER BY academic_year DESC, term DESC`,
      [req.params.studentId]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// Download one terminal report PDF for this child.
router.get("/children/:studentId/reports/pdf", async (req, res, next) => {
  try {
    if (!(await parentCanSeeStudent(req, req.params.studentId))) {
      return res.status(403).json({ error: "This student is not linked to your account." });
    }
    const { term, academicYear } = req.query;
    if (!term || !academicYear) return res.status(400).json({ error: "Term and academic year are required." });

    const { rows } = await pool.query(
      `SELECT file_path FROM terminal_reports WHERE student_id = $1 AND term = $2 AND academic_year = $3`,
      [req.params.studentId, term, Number(academicYear)]
    );
    if (!rows[0]) return res.status(404).json({ error: "This report is not available yet." });
    if (!fs.existsSync(rows[0].file_path)) {
      return res.status(410).json({ error: "This report file is being refreshed. Please contact the school office." });
    }
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'attachment; filename="Terminal_Report.pdf"');
    fs.createReadStream(rows[0].file_path).pipe(res);
  } catch (err) { next(err); }
});

module.exports = { router };
