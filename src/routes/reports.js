const express = require("express");
const router = express.Router();

const { pool } = require("../db");
const { requireAuth, requireRole, captureRequestContext } = require("../middleware/auth");
const { generateTerminalReport, SUBJECTS } = require("../services/pdfGenerator");
const { writeAuditLog } = require("../services/auditLog");
const fs = require("fs");

router.use(requireAuth, requireRole("administrator", "super_administrator", "headmaster"), captureRequestContext);

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

// ---------------------------------------------------------------
// Terminal Report — one consolidated PDF per student per term,
// all nine subjects on a single card. Regenerating for the same
// student/term/year overwrites the previous file (no versioning
// at this level — it always reflects whatever is published now).
// ---------------------------------------------------------------
router.post("/terminal/:studentId", async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: studentRows } = await client.query(
      `SELECT id, full_name, class, admission_no FROM students WHERE id = $1`,
      [req.params.studentId]
    );
    if (!studentRows[0]) throw { status: 404, message: "Student not found." };
    const student = studentRows[0];

    let { term, academicYear } = req.query;
    if (!term || !academicYear) {
      const { rows: termRows } = await client.query(`SELECT term, academic_year FROM term_settings WHERE id = 1`);
      if (!termRows[0]) throw { status: 400, message: "No current term is set, and none was provided." };
      term = term || termRows[0].term;
      academicYear = academicYear || termRows[0].academic_year;
    }
    academicYear = Number(academicYear);

    const { rows: publishedSubjects } = await client.query(
      `SELECT e.subject, m.class_score, m.exam_score, m.score AS total, m.grade, m.remarks
       FROM exam_marks m
       JOIN exams e ON e.id = m.exam_id AND m.version = e.current_version
       WHERE e.status = 'published' AND e.class = $1 AND e.term = $2 AND e.academic_year = $3 AND m.student_id = $4`,
      [student.class, term, academicYear, student.id]
    );
    const bySubject = Object.fromEntries(publishedSubjects.map((r) => [r.subject, r]));
    const subjectRows = SUBJECTS.map((s) => bySubject[s] || null);
    const subjectsIncluded = publishedSubjects.length;
    const aggregateTotal = subjectsIncluded > 0
      ? publishedSubjects.reduce((sum, r) => sum + Number(r.total), 0).toFixed(2)
      : null;

    const { rows: rankRows } = await client.query(
      `WITH totals AS (
         SELECT m.student_id, SUM(m.score)::numeric AS total
         FROM exam_marks m
         JOIN exams e ON e.id = m.exam_id AND m.version = e.current_version
         WHERE e.status = 'published' AND e.class = $1 AND e.term = $2 AND e.academic_year = $3
         GROUP BY m.student_id
       ), ranked AS (
         SELECT student_id, RANK() OVER (ORDER BY total DESC) AS pos, COUNT(*) OVER () AS class_size
         FROM totals
       )
       SELECT pos, class_size FROM ranked WHERE student_id = $4`,
      [student.class, term, academicYear, student.id]
    );
    const positionInClass = rankRows[0]?.pos || null;
    const classSize = rankRows[0]?.class_size || null;

    const result = await generateTerminalReport({
      student, className: student.class, term, academicYear, subjectRows,
      aggregateTotal, subjectsIncluded, positionInClass, classSize,
      generatedByName: req.user.name, generatedByUserId: req.user.id, dbClient: client,
    });

    await writeAuditLog(client, {
      examId: null, user: req.user,
      action: `Generated Terminal Report for ${student.full_name} (${student.class}, ${term} ${academicYear}) — ${subjectsIncluded} of ${SUBJECTS.length} subjects included.`,
      previousValue: null, newValue: result.qrToken,
      ip: req.auditContext.ip, device: req.auditContext.device,
    });

    await client.query("COMMIT");
    res.status(201).json({ ...result, subjectsIncluded, aggregateTotal, positionInClass, classSize });
  } catch (err) { await client.query("ROLLBACK"); next(err); } finally { client.release(); }
});

// Fetch metadata for an already-generated terminal report (no regeneration).
router.get("/terminal/:studentId", async (req, res, next) => {
  try {
    let { term, academicYear } = req.query;
    if (!term || !academicYear) {
      const { rows: termRows } = await pool.query(`SELECT term, academic_year FROM term_settings WHERE id = 1`);
      if (!termRows[0]) return res.status(404).json({ error: "No terminal report found." });
      term = term || termRows[0].term;
      academicYear = academicYear || termRows[0].academic_year;
    }
    const { rows } = await pool.query(
      `SELECT * FROM terminal_reports WHERE student_id = $1 AND term = $2 AND academic_year = $3`,
      [req.params.studentId, term, Number(academicYear)]
    );
    if (!rows[0]) return res.status(404).json({ error: "No terminal report generated yet for this term." });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// Download the actual PDF (staff-only; the public QR flow is served
// separately from /verify, unauthenticated, like the per-subject cards).
router.get("/terminal/:studentId/pdf", async (req, res, next) => {
  try {
    let { term, academicYear } = req.query;
    if (!term || !academicYear) {
      const { rows: termRows } = await pool.query(`SELECT term, academic_year FROM term_settings WHERE id = 1`);
      if (!termRows[0]) return res.status(404).send("No terminal report found.");
      term = term || termRows[0].term;
      academicYear = academicYear || termRows[0].academic_year;
    }
    const { rows } = await pool.query(
      `SELECT file_path FROM terminal_reports WHERE student_id = $1 AND term = $2 AND academic_year = $3`,
      [req.params.studentId, term, Number(academicYear)]
    );
    if (!rows[0]) return res.status(404).send("No terminal report generated yet for this term.");
    if (!fs.existsSync(rows[0].file_path)) return res.status(410).send("This report's file is no longer available and needs regenerating.");
    res.setHeader("Content-Type", "application/pdf");
    fs.createReadStream(rows[0].file_path).pipe(res);
  } catch (err) { next(err); }
});

module.exports = { router };
