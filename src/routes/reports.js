const express = require("express");
const router = express.Router();

const { pool } = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");

router.use(requireAuth, requireRole("administrator", "super_administrator", "headmaster"));

// ---------------------------------------------------------------
// Dashboard summary — pictorial overview across students, exams,
// and PTA dues. One call, several aggregates, all class/subject
// scoped so charts can be built directly from the response.
// ---------------------------------------------------------------
router.get("/dashboard", async (req, res, next) => {
  try {
    const [studentsByClass, examStatusCounts, subjectAverages, ptaByStatus, ptaByClass] = await Promise.all([
      pool.query(`SELECT class, COUNT(*)::int AS count FROM students GROUP BY class ORDER BY class`),

      pool.query(`SELECT status, COUNT(*)::int AS count FROM exams GROUP BY status`),

      pool.query(
        `SELECT e.subject, e.class, ROUND(AVG(m.score), 1)::float AS avg_score, COUNT(DISTINCT m.student_id)::int AS student_count
         FROM exam_marks m
         JOIN exams e ON e.id = m.exam_id AND m.version = e.current_version
         WHERE e.status = 'published'
         GROUP BY e.subject, e.class
         ORDER BY e.subject, e.class`
      ),

      pool.query(
        `SELECT status, COUNT(*)::int AS count, COALESCE(SUM(amount), 0)::float AS total_amount
         FROM pta_payments GROUP BY status`
      ),

      pool.query(
        `SELECT s.class,
                COALESCE(SUM(pp.amount) FILTER (WHERE pp.status = 'recorded'), 0)::float AS collected,
                COALESCE(SUM(pp.amount) FILTER (WHERE pp.status IN ('pending_admin','pending_headmaster')), 0)::float AS pending,
                COUNT(*) FILTER (WHERE pp.status = 'recorded')::int AS recorded_count
         FROM pta_payments pp JOIN students s ON s.id = pp.student_id
         GROUP BY s.class ORDER BY s.class`
      ),
    ]);

    res.json({
      studentsByClass: studentsByClass.rows,
      examStatusCounts: examStatusCounts.rows,
      subjectAverages: subjectAverages.rows,
      ptaByStatus: ptaByStatus.rows,
      ptaByClass: ptaByClass.rows,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------
// Printable report data — filtered by class, subject, and/or a
// PTA status, for the Reports/Print screen. Returns raw rows;
// the frontend renders and prints them.
// ---------------------------------------------------------------
router.get("/marks", async (req, res, next) => {
  try {
    const { class: className, subject, term, academicYear } = req.query;
    const conditions = ["e.status = 'published'"];
    const params = [];

    if (className) { params.push(className); conditions.push(`e.class = $${params.length}`); }
    if (subject) { params.push(subject); conditions.push(`e.subject = $${params.length}`); }
    if (term) { params.push(term); conditions.push(`e.term = $${params.length}`); }
    if (academicYear) { params.push(Number(academicYear)); conditions.push(`e.academic_year = $${params.length}`); }

    const { rows } = await pool.query(
      `SELECT e.class, e.subject, e.term, e.academic_year, s.full_name AS student_name, s.admission_no,
              m.score, m.grade, m.remarks
       FROM exam_marks m
       JOIN exams e ON e.id = m.exam_id AND m.version = e.current_version
       JOIN students s ON s.id = m.student_id
       WHERE ${conditions.join(" AND ")}
       ORDER BY e.class, e.subject, s.full_name`,
      params
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.get("/pta", async (req, res, next) => {
  try {
    const { class: className, status, term, academicYear } = req.query;
    const conditions = ["1=1"];
    const params = [];

    if (className) { params.push(className); conditions.push(`s.class = $${params.length}`); }
    if (status) { params.push(status); conditions.push(`pp.status = $${params.length}`); }
    if (term) { params.push(term); conditions.push(`pp.term = $${params.length}`); }
    if (academicYear) { params.push(Number(academicYear)); conditions.push(`pp.academic_year = $${params.length}`); }

    const { rows } = await pool.query(
      `SELECT s.class, s.full_name AS student_name, s.admission_no, pp.term, pp.academic_year,
              pp.amount, pp.status, pp.created_at, u.name AS collected_by_name
       FROM pta_payments pp
       JOIN students s ON s.id = pp.student_id
       JOIN users u ON u.id = pp.collected_by
       WHERE ${conditions.join(" AND ")}
       ORDER BY s.class, s.full_name`,
      params
    );
    res.json(rows);
  } catch (err) { next(err); }
});

module.exports = { router };
