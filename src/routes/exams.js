const express = require("express");
const router = express.Router();
const multer = require("multer");
const XLSX = require("xlsx");

const { pool } = require("../db");
const { requireAuth, requireRole, captureRequestContext } = require("../middleware/auth");
const { writeAuditLog } = require("../services/auditLog");
const { generateReportCard, generateBroadsheet } = require("../services/pdfGenerator");
const { sendResultSms, sendResultWhatsapp } = require("../services/mnotify");

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

router.use(requireAuth, captureRequestContext);

// Read-only term settings
router.get("/settings/term", async (req, res, next) => {
  try {
    const { rows } = await pool.query(`SELECT term, academic_year FROM term_settings WHERE id = 1`);
    res.json(rows[0] || null);
  } catch (err) { next(err); }
});

// Teacher class/subject assignments
router.get("/my-assignments", requireRole("teacher"), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT sa.subject, c.id AS class_id, c.name AS class_name, c.academic_year
       FROM subject_assignments sa
       JOIN classes c ON c.id = sa.class_id
       JOIN term_settings ts ON ts.academic_year = c.academic_year
       WHERE sa.teacher_id = $1
       ORDER BY c.name, sa.subject`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// Create new examination record
router.post("/", requireRole("teacher"), async (req, res, next) => {
  const { classId, subject } = req.body;
  if (!classId || !subject) return res.status(400).json({ error: "classId and subject are required." });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: assignmentRows } = await client.query(
      `SELECT sa.*, c.name AS class_name, c.academic_year FROM subject_assignments sa
       JOIN classes c ON c.id = sa.class_id
       WHERE sa.class_id = $1 AND sa.subject = $2 AND sa.teacher_id = $3`,
      [classId, subject, req.user.id]
    );
    const assignment = assignmentRows[0];
    if (!assignment) {
      throw { status: 403, message: "You are not assigned to teach this subject for this class." };
    }

    const { rows: termRows } = await client.query(`SELECT term, academic_year FROM term_settings WHERE id = 1`);
    const currentTerm = termRows[0];
    if (!currentTerm || currentTerm.academic_year !== assignment.academic_year) {
      throw { status: 409, message: "This class belongs to a different academic year than the current locked term." };
    }

    const { rows } = await client.query(
      `INSERT INTO exams (class, subject, term, academic_year, teacher_id, class_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [assignment.class_name, subject, currentTerm.term, currentTerm.academic_year, req.user.id, classId]
    );
    const exam = rows[0];
    await writeAuditLog(client, {
      examId: exam.id, user: req.user, action: "Created new exam record.",
      previousValue: null, newValue: `${assignment.class_name} / ${subject} / ${currentTerm.term} ${currentTerm.academic_year}`,
      ip: req.auditContext.ip, device: req.auditContext.device,
    });
    await client.query("COMMIT");
    res.status(201).json(exam);
  } catch (err) { await client.query("ROLLBACK"); next(err); } finally { client.release(); }
});

async function getExamOr404(client, id) {
  const { rows } = await client.query(`SELECT * FROM exams WHERE id = $1`, [id]);
  if (!rows[0]) throw { status: 404, message: "Examination not found." };
  return rows[0];
}

function assertLive(exam) {
  if (exam.status === "locked") {
    const err = new Error("This examination has been permanently locked after the 21-day validation period. No further modifications are permitted.");
    err.status = 423;
    throw err;
  }
}

// ---------------------------------------------------------------
// STAGE 1 — Teacher: edit marks — Continuous Assessment model
//
//   Class Work = Individual Test (0-15) + Group Work (0-15)
//              + Class Test (0-15) + Project (0-15)
//              = raw total out of 60, scaled to 50
//   Exam       = entered raw out of 100, scaled to 50
//   class_score / exam_score keep their old names + meaning (both out of
//   50, summing via the generated "score" column to a /100 total) so
//   nothing downstream (report cards, broadsheets, positions) needs to
//   change — only what feeds into them does.
// ---------------------------------------------------------------
function scaleContinuousAssessment({ individualTest, groupWork, classTest, project, examRaw }) {
  const classworkRaw = individualTest + groupWork + classTest + project; // out of 60
  const classScore = Math.round((classworkRaw * 50 / 60) * 100) / 100;   // scaled to 50, 2dp
  const examScore = Math.round((examRaw * 50 / 100) * 100) / 100;        // scaled to 50, 2dp
  return { classScore, examScore };
}

router.put("/:id/marks", requireRole("teacher"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const exam = await getExamOr404(client, req.params.id);
    assertLive(exam);
    if (exam.teacher_id !== req.user.id) throw { status: 403, message: "You may only edit your own exam." };
    if (!["draft", "admin_returned"].includes(exam.status)) {
      throw { status: 409, message: "Marks can only be edited while in draft or returned status." };
    }

    const { marks } = req.body; // [{ student_id, individual_test, group_work, class_test, project, exam_raw, grade?, remarks? }]
    for (const m of marks) {
      const individualTest = Number(m.individual_test || 0);
      const groupWork = Number(m.group_work || 0);
      const classTest = Number(m.class_test || 0);
      const project = Number(m.project || 0);
      const examRaw = Number(m.exam_raw || 0);

      const components = [
        ["Individual Test", individualTest],
        ["Group Work", groupWork],
        ["Class Test", classTest],
        ["Project", project],
      ];
      for (const [label, val] of components) {
        if (val < 0 || val > 15) {
          throw { status: 400, message: `${label} for student ID ${m.student_id} must be between 0 and 15.` };
        }
      }
      if (examRaw < 0 || examRaw > 100) {
        throw { status: 400, message: `Exam score for student ID ${m.student_id} must be between 0 and 100.` };
      }

      const { classScore, examScore } = scaleContinuousAssessment({ individualTest, groupWork, classTest, project, examRaw });

      await client.query(
        `INSERT INTO exam_marks (exam_id, version, student_id, individual_test, group_work, class_test, project, exam_raw, class_score, exam_score, grade, remarks)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (exam_id, version, student_id)
         DO UPDATE SET
           individual_test = EXCLUDED.individual_test,
           group_work = EXCLUDED.group_work,
           class_test = EXCLUDED.class_test,
           project = EXCLUDED.project,
           exam_raw = EXCLUDED.exam_raw,
           class_score = EXCLUDED.class_score,
           exam_score = EXCLUDED.exam_score,
           grade = EXCLUDED.grade,
           remarks = EXCLUDED.remarks`,
        [exam.id, exam.current_version, m.student_id, individualTest, groupWork, classTest, project, examRaw, classScore, examScore, m.grade || null, m.remarks || null]
      );
    }

    await writeAuditLog(client, {
      examId: exam.id, user: req.user, action: "Edited Continuous Assessment marks prior to submission.",
      previousValue: null, newValue: `${marks.length} student score(s) updated`,
      ip: req.auditContext.ip, device: req.auditContext.device,
    });

    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (err) { await client.query("ROLLBACK"); next(err); } finally { client.release(); }
});

// Excel Spreadsheet Bulk Upload Mapping
function normalizeHeader(h) {
  return String(h || "").toLowerCase().replace(/[^a-z]/g, "");
}

const MARKS_HEADER_MAP = {
  admissionno: "admissionNo", admissionnumber: "admissionNo",
  individualtest: "individualTest", indtest: "individualTest", individual: "individualTest", test: "individualTest",
  groupwork: "groupWork", group: "groupWork",
  classtest: "classTest",
  project: "project",
  exam: "examRaw", examscore: "examRaw", examination: "examRaw", examraw: "examRaw",
  grade: "grade",
  remarks: "remarks", remark: "remarks", comment: "remarks",
};

router.post("/:id/marks/bulk-upload", requireRole("teacher"), upload.single("file"), async (req, res, next) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded." });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const exam = await getExamOr404(client, req.params.id);
    assertLive(exam);
    if (exam.teacher_id !== req.user.id) throw { status: 403, message: "You may only edit your own exam." };
    if (!["draft", "admin_returned"].includes(exam.status)) {
      throw { status: 409, message: "Marks can only be edited while in draft or returned status." };
    }

    const workbook = XLSX.read(req.file.buffer, { type: "buffer" });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rawRows = XLSX.utils.sheet_to_json(sheet, { defval: "" });

    const results = { updated: [], skipped: [], errors: [] };

    for (let i = 0; i < rawRows.length; i++) {
      const raw = rawRows[i];
      const row = {};
      for (const key of Object.keys(raw)) {
        const mapped = MARKS_HEADER_MAP[normalizeHeader(key)];
        if (mapped) row[mapped] = String(raw[key]).trim();
      }

      const admissionNo = row.admissionNo;
      const individualTest = Number(row.individualTest || 0);
      const groupWork = Number(row.groupWork || 0);
      const classTest = Number(row.classTest || 0);
      const project = Number(row.project || 0);
      const examRaw = Number(row.examRaw || 0);

      if (!admissionNo || [individualTest, groupWork, classTest, project, examRaw].some((v) => Number.isNaN(v))) {
        results.errors.push({ row: i + 2, reason: "Missing or invalid admission number or scores." });
        continue;
      }

      if ([individualTest, groupWork, classTest, project].some((v) => v < 0 || v > 15)) {
        results.errors.push({ row: i + 2, reason: "Individual Test, Group Work, Class Test, and Project must each be 0-15." });
        continue;
      }
      if (examRaw < 0 || examRaw > 100) {
        results.errors.push({ row: i + 2, reason: "Exam score must be 0-100." });
        continue;
      }

      const { rows: studentRows } = await client.query(`SELECT id, full_name FROM students WHERE admission_no = $1`, [admissionNo]);
      if (!studentRows[0]) {
        results.skipped.push({ row: i + 2, admissionNo, reason: "No student found with this admission number." });
        continue;
      }

      const { classScore, examScore } = scaleContinuousAssessment({ individualTest, groupWork, classTest, project, examRaw });

      await client.query(
        `INSERT INTO exam_marks (exam_id, version, student_id, individual_test, group_work, class_test, project, exam_raw, class_score, exam_score, grade, remarks)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (exam_id, version, student_id)
         DO UPDATE SET
           individual_test = EXCLUDED.individual_test,
           group_work = EXCLUDED.group_work,
           class_test = EXCLUDED.class_test,
           project = EXCLUDED.project,
           exam_raw = EXCLUDED.exam_raw,
           class_score = EXCLUDED.class_score,
           exam_score = EXCLUDED.exam_score,
           grade = EXCLUDED.grade,
           remarks = EXCLUDED.remarks`,
        [exam.id, exam.current_version, studentRows[0].id, individualTest, groupWork, classTest, project, examRaw, classScore, examScore, row.grade || null, row.remarks || null]
      );
      results.updated.push(studentRows[0].full_name);
    }

    await writeAuditLog(client, {
      examId: exam.id, user: req.user, action: `Bulk-uploaded marks: ${results.updated.length} student(s) updated.`,
      previousValue: null, newValue: `${results.updated.length} updated, ${results.skipped.length} skipped`,
      ip: req.auditContext.ip, device: req.auditContext.device,
    });

    await client.query("COMMIT");
    res.json(results);
  } catch (err) { await client.query("ROLLBACK"); next(err); } finally { client.release(); }
});

// Admin defines dynamic assessment categories
router.post("/assessments/config", requireRole("administrator", "super_administrator"), async (req, res, next) => {
  const { academicYear, term, className, subject, title, maxScore } = req.body;
  try {
    const { rows } = await pool.query(
      `INSERT INTO assessment_categories (academic_year, term, class_name, subject, title, max_score)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [academicYear, term, className, subject, title, maxScore || 10]
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

// STAGE 1 -> Teacher Submits
router.post("/:id/submit", requireRole("teacher"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const exam = await getExamOr404(client, req.params.id);
    assertLive(exam);
    if (exam.teacher_id !== req.user.id) throw { status: 403, message: "You may only submit your own exam." };
    if (!["draft", "admin_returned"].includes(exam.status)) throw { status: 409, message: "Nothing to submit at this stage." };

    await client.query(`UPDATE exams SET status = 'submitted' WHERE id = $1`, [exam.id]);
    await writeAuditLog(client, {
      examId: exam.id, user: req.user, action: "Submitted marks for Administrator review.",
      previousValue: exam.status, newValue: "submitted",
      ip: req.auditContext.ip, device: req.auditContext.device,
    });

    await client.query("COMMIT");
    res.json({ ok: true, status: "submitted" });
  } catch (err) { await client.query("ROLLBACK"); next(err); } finally { client.release(); }
});

// STAGE 2 -> Admin Approve
router.post("/:id/admin-approve", requireRole("administrator"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const exam = await getExamOr404(client, req.params.id);
    assertLive(exam);
    if (!["submitted", "hm_returned"].includes(exam.status)) throw { status: 409, message: "Nothing pending admin approval." };

    await client.query(`UPDATE exams SET status = 'admin_approved' WHERE id = $1`, [exam.id]);
    await writeAuditLog(client, {
      examId: exam.id, user: req.user, action: "Approved submission and forwarded to Headmaster.",
      previousValue: exam.status, newValue: "admin_approved",
      ip: req.auditContext.ip, device: req.auditContext.device,
    });

    await client.query("COMMIT");
    res.json({ ok: true, status: "admin_approved" });
  } catch (err) { await client.query("ROLLBACK"); next(err); } finally { client.release(); }
});

// STAGE 2 -> Admin Return to Teacher
router.post("/:id/admin-return", requireRole("administrator"), async (req, res, next) => {
  const { reason } = req.body;
  if (!reason?.trim()) return res.status(400).json({ error: "A comment is required to return work to the teacher." });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const exam = await getExamOr404(client, req.params.id);
    assertLive(exam);
    if (exam.status !== "submitted") throw { status: 409, message: "Only submitted work can be returned." };

    await client.query(`UPDATE exams SET status = 'admin_returned' WHERE id = $1`, [exam.id]);
    await writeAuditLog(client, {
      examId: exam.id, user: req.user, action: "Returned submission to teacher for correction.",
      previousValue: "submitted", newValue: "admin_returned", reason,
      ip: req.auditContext.ip, device: req.auditContext.device,
    });

    await client.query("COMMIT");
    res.json({ ok: true, status: "admin_returned" });
  } catch (err) { await client.query("ROLLBACK"); next(err); } finally { client.release(); }
});

// STAGE 3 -> Headmaster Return to Admin
router.post("/:id/hm-return", requireRole("headmaster"), async (req, res, next) => {
  const { reason } = req.body;
  if (!reason?.trim()) return res.status(400).json({ error: "A comment is required to return work to the Administrator." });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const exam = await getExamOr404(client, req.params.id);
    assertLive(exam);
    if (exam.status !== "admin_approved") throw { status: 409, message: "Only admin-approved work can be returned." };

    await client.query(`UPDATE exams SET status = 'hm_returned' WHERE id = $1`, [exam.id]);
    await writeAuditLog(client, {
      examId: exam.id, user: req.user, action: "Returned submission to Administrator for further review.",
      previousValue: "admin_approved", newValue: "hm_returned", reason,
      ip: req.auditContext.ip, device: req.auditContext.device,
    });

    await client.query("COMMIT");
    res.json({ ok: true, status: "hm_returned" });
  } catch (err) { await client.query("ROLLBACK"); next(err); } finally { client.release(); }
});

// STAGE 3 -> Headmaster Publish
router.post("/:id/publish", requireRole("headmaster"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const exam = await getExamOr404(client, req.params.id);
    assertLive(exam);
    if (exam.status !== "admin_approved") throw { status: 409, message: "Only admin-approved work can be published." };

    const publishedAt = new Date();
    const lockAt = new Date(publishedAt.getTime() + 21 * 24 * 60 * 60 * 1000);

    await client.query(
      `UPDATE exams SET status = 'published', published_at = $1, lock_at = $2, headmaster_approver_id = $3 WHERE id = $4`,
      [publishedAt, lockAt, req.user.id, exam.id]
    );
    await client.query(
      `INSERT INTO exam_versions (exam_id, version, changed_by_user_id, admin_approver_id, headmaster_approver_id, note)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [exam.id, exam.current_version, exam.teacher_id, null, req.user.id, "Original published version."]
    );

    const { rows: marksRows } = await client.query(
      `SELECT em.*, s.full_name, s.parent_phone, s.parent_whatsapp
       FROM exam_marks em JOIN students s ON s.id = em.student_id
       WHERE em.exam_id = $1 AND em.version = $2`,
      [exam.id, exam.current_version]
    );

    for (const row of marksRows) {
      await generateReportCard({
        exam, student: { id: row.student_id, full_name: row.full_name },
        version: exam.current_version, marksRow: row, dbClient: client,
      });

      if (row.parent_phone) {
        await client.query(
          `INSERT INTO notifications (exam_id, student_id, channel, destination, status) VALUES ($1,$2,'sms',$3,'queued')`,
          [exam.id, row.student_id, row.parent_phone]
        );
      }
      if (row.parent_whatsapp) {
        await client.query(
          `INSERT INTO notifications (exam_id, student_id, channel, destination, status) VALUES ($1,$2,'whatsapp',$3,'queued')`,
          [exam.id, row.student_id, row.parent_whatsapp]
        );
      }
    }

    await generateBroadsheet({ exam, version: exam.current_version, marksRows, dbClient: client });

    await writeAuditLog(client, {
      examId: exam.id, user: req.user,
      action: "Approved and PUBLISHED official results. Report cards & broadsheets generated.",
      previousValue: "admin_approved", newValue: "published",
      ip: req.auditContext.ip, device: req.auditContext.device,
    });

    await client.query("COMMIT");

    dispatchQueuedNotifications(exam.id).catch((e) => console.error("Notification dispatch error:", e));

    res.json({ ok: true, status: "published", publishedAt, lockAt });
  } catch (err) { await client.query("ROLLBACK"); next(err); } finally { client.release(); }
});

async function dispatchQueuedNotifications(examId) {
  const { rows } = await pool.query(
    `SELECT n.*, s.full_name, e.class, e.id as exam_id
     FROM notifications n JOIN students s ON s.id = n.student_id JOIN exams e ON e.id = n.exam_id
     WHERE n.exam_id = $1 AND n.status = 'queued'`, [examId]
  );
  const portalLink = `${process.env.PORTAL_BASE_URL}/results/${examId}`;
  for (const n of rows) {
    try {
      const result = n.channel === "sms"
        ? await sendResultSms({ to: n.destination, studentName: n.full_name, className: n.class, portalLink })
        : await sendResultWhatsapp({ to: n.destination, studentName: n.full_name, className: n.class, portalLink });
      await pool.query(`UPDATE notifications SET status = 'sent', provider_ref = $1, sent_at = now() WHERE id = $2`, [result.providerRef, n.id]);
    } catch (e) {
      await pool.query(`UPDATE notifications SET status = 'failed', error = $1 WHERE id = $2`, [e.message, n.id]);
    }
  }
}

// Fetch all exams
router.get("/", async (req, res, next) => {
  try {
    const isStaff = ["administrator", "headmaster", "super_administrator"].includes(req.user.role);
    const { rows } = isStaff
      ? await pool.query(`SELECT e.*, u.name AS teacher_name FROM exams e JOIN users u ON u.id = e.teacher_id ORDER BY e.created_at DESC`)
      : await pool.query(`SELECT e.*, u.name AS teacher_name FROM exams e JOIN users u ON u.id = e.teacher_id WHERE e.teacher_id = $1 ORDER BY e.created_at DESC`, [req.user.id]);
    res.json(rows);
  } catch (err) { next(err); }
});

// Fetch single exam by ID
router.get("/:id", async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT e.*, u.name AS teacher_name FROM exams e JOIN users u ON u.id = e.teacher_id WHERE e.id = $1`,
      [req.params.id]
    );
    const exam = rows[0];
    if (!exam) return res.status(404).json({ error: "Examination not found." });

    const { rows: marks } = await pool.query(
      `SELECT em.*, s.full_name FROM exam_marks em JOIN students s ON s.id = em.student_id
       WHERE em.exam_id = $1 AND em.version = $2 ORDER BY s.full_name`,
      [exam.id, exam.current_version]
    );
    res.json({ ...exam, marks });
  } catch (err) { next(err); }
});

module.exports = { router, dispatchQueuedNotifications };
