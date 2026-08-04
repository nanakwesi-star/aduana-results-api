const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const { requireAuth, requireRole, captureRequestContext } = require("../middleware/auth");
const { writeAuditLog } = require("../services/auditLog");
const { generateReportCard, generateBroadsheet } = require("../services/pdfGenerator");
const { sendResultSms, sendResultWhatsapp } = require("../services/mnotify");

router.use(requireAuth, captureRequestContext);

// ---------------------------------------------------------------
// Create a new exam record (Teacher starts a draft)
// ---------------------------------------------------------------
router.post("/", requireRole("teacher"), async (req, res, next) => {
  const { class: className, subject, term, academicYear } = req.body;
  if (!className || !subject || !term || !academicYear) {
    return res.status(400).json({ error: "class, subject, term, and academicYear are all required." });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `INSERT INTO exams (class, subject, term, academic_year, teacher_id) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [className, subject, term, academicYear, req.user.id]
    );
    const exam = rows[0];
    await writeAuditLog(client, {
      examId: exam.id, user: req.user, action: "Created new exam record.",
      previousValue: null, newValue: `${className} / ${subject} / ${term} ${academicYear}`,
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
    err.status = 423; // Locked
    throw err;
  }
}

// ---------------------------------------------------------------
// STAGE 1 — Teacher: edit marks (only in draft / admin_returned)
// ---------------------------------------------------------------
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

    const { marks } = req.body; // [{ student_id, score, grade?, remarks? }]
    for (const m of marks) {
      await client.query(
        `INSERT INTO exam_marks (exam_id, version, student_id, score, grade, remarks)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (exam_id, version, student_id)
         DO UPDATE SET score = EXCLUDED.score, grade = EXCLUDED.grade, remarks = EXCLUDED.remarks`,
        [exam.id, exam.current_version, m.student_id, m.score, m.grade || null, m.remarks || null]
      );
    }

    await writeAuditLog(client, {
      examId: exam.id, user: req.user, action: "Edited marks prior to submission.",
      previousValue: null, newValue: `${marks.length} student score(s) updated`,
      ip: req.auditContext.ip, device: req.auditContext.device,
    });

    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (err) { await client.query("ROLLBACK"); next(err); } finally { client.release(); }
});

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

// ---------------------------------------------------------------
// STAGE 2 — Administrator review
// ---------------------------------------------------------------
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

// ---------------------------------------------------------------
// STAGE 3 — Headmaster final validation
// ---------------------------------------------------------------
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

// Only the Headmaster may publish. This is the single most consequential
// endpoint in the system: it flips status, stamps the 21-day lock date,
// snapshots version 1, generates every document, and queues notifications
// — all inside one transaction so nothing half-publishes.
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
      const { verifyUrl } = await generateReportCard({
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
      action: "Approved and PUBLISHED official results. Report cards & broadsheets generated. Parent Portal updated. Notifications queued.",
      previousValue: "admin_approved", newValue: "published",
      ip: req.auditContext.ip, device: req.auditContext.device,
    });

    await client.query("COMMIT");

    // Fire notifications after commit so a provider outage never blocks publication.
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

// ---------------------------------------------------------------
// 21-DAY WINDOW — Correction requests
// ---------------------------------------------------------------
router.post("/:id/corrections", requireRole("teacher", "administrator", "headmaster"), async (req, res, next) => {
  const { reason, proposedMarks } = req.body;
  if (!reason?.trim()) return res.status(400).json({ error: "A written reason is required for a correction request." });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const exam = await getExamOr404(client, req.params.id);
    if (exam.status !== "published") throw { status: 409, message: "Corrections can only be requested against a published record within its 21-day window." };
    if (new Date() >= new Date(exam.lock_at)) throw { status: 423, message: "The 21-day correction window has closed." };

    const { rows } = await client.query(
      `INSERT INTO correction_requests (exam_id, requested_by_id, reason, proposed_marks)
       VALUES ($1,$2,$3,$4) RETURNING id`,
      [exam.id, req.user.id, reason, JSON.stringify(proposedMarks)]
    );
    await client.query(`UPDATE exams SET status = 'correction_pending_admin' WHERE id = $1`, [exam.id]);
    await writeAuditLog(client, {
      examId: exam.id, user: req.user, action: "Filed a formal Correction Request against published results.",
      previousValue: "published", newValue: "correction_pending_admin", reason,
      ip: req.auditContext.ip, device: req.auditContext.device,
    });

    await client.query("COMMIT");
    res.json({ ok: true, correctionRequestId: rows[0].id });
  } catch (err) { await client.query("ROLLBACK"); next(err); } finally { client.release(); }
});

router.post("/corrections/:crId/admin-decision", requireRole("administrator"), async (req, res, next) => {
  const { approve, reason } = req.body;
  if (!approve && !reason?.trim()) return res.status(400).json({ error: "A reason is required to reject a correction request." });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: crRows } = await client.query(`SELECT * FROM correction_requests WHERE id = $1`, [req.params.crId]);
    const cr = crRows[0];
    if (!cr || cr.status !== "pending_admin") throw { status: 409, message: "This correction request is not awaiting Administrator decision." };
    const exam = await getExamOr404(client, cr.exam_id);

    if (approve) {
      await client.query(`UPDATE correction_requests SET status = 'pending_headmaster', admin_decided_by = $1, admin_decided_at = now() WHERE id = $2`, [req.user.id, cr.id]);
      await client.query(`UPDATE exams SET status = 'correction_pending_hm' WHERE id = $1`, [exam.id]);
      await writeAuditLog(client, { examId: exam.id, user: req.user, action: "Approved Correction Request; forwarded to Headmaster for final approval.", previousValue: "correction_pending_admin", newValue: "correction_pending_hm", ip: req.auditContext.ip, device: req.auditContext.device });
    } else {
      await client.query(`UPDATE correction_requests SET status = 'rejected_admin', admin_decided_by = $1, admin_decided_at = now(), admin_decision_reason = $2 WHERE id = $3`, [req.user.id, reason, cr.id]);
      await client.query(`UPDATE exams SET status = 'published' WHERE id = $1`, [exam.id]);
      await writeAuditLog(client, { examId: exam.id, user: req.user, action: "Rejected Correction Request. Published record unchanged.", previousValue: "correction_pending_admin", newValue: "published", reason, ip: req.auditContext.ip, device: req.auditContext.device });
    }

    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (err) { await client.query("ROLLBACK"); next(err); } finally { client.release(); }
});

// Final approval creates the new version, preserving every prior one.
router.post("/corrections/:crId/headmaster-decision", requireRole("headmaster"), async (req, res, next) => {
  const { approve, reason } = req.body;
  if (!approve && !reason?.trim()) return res.status(400).json({ error: "A reason is required to reject a correction request." });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: crRows } = await client.query(`SELECT * FROM correction_requests WHERE id = $1`, [req.params.crId]);
    const cr = crRows[0];
    if (!cr || cr.status !== "pending_headmaster") throw { status: 409, message: "This correction request is not awaiting Headmaster decision." };
    const exam = await getExamOr404(client, cr.exam_id);
    assertLive(exam);

    if (approve) {
      const newVersion = exam.current_version + 1;
      for (const m of cr.proposed_marks) {
        await client.query(
          `INSERT INTO exam_marks (exam_id, version, student_id, score, grade, remarks) VALUES ($1,$2,$3,$4,$5,$6)`,
          [exam.id, newVersion, m.student_id, m.score, m.grade || null, m.remarks || null]
        );
      }
      await client.query(
        `INSERT INTO exam_versions (exam_id, version, changed_by_user_id, admin_approver_id, headmaster_approver_id, note, is_correction)
         VALUES ($1,$2,$3,$4,$5,$6,TRUE)`,
        [exam.id, newVersion, cr.requested_by_id, cr.admin_decided_by, req.user.id, cr.reason]
      );
      await client.query(`UPDATE exams SET status = 'published', current_version = $1 WHERE id = $2`, [newVersion, exam.id]);
      await client.query(`UPDATE correction_requests SET status = 'approved', headmaster_decided_by = $1, headmaster_decided_at = now(), resulting_version = $2 WHERE id = $3`, [req.user.id, newVersion, cr.id]);

      // Regenerate documents for the new version only — old version's PDFs remain untouched in report_cards/broadsheets.
      const { rows: marksRows } = await client.query(
        `SELECT em.*, s.full_name FROM exam_marks em JOIN students s ON s.id = em.student_id WHERE em.exam_id = $1 AND em.version = $2`,
        [exam.id, newVersion]
      );
      for (const row of marksRows) {
        await generateReportCard({ exam: { ...exam, current_version: newVersion }, student: { id: row.student_id, full_name: row.full_name }, version: newVersion, marksRow: row, dbClient: client });
      }
      await generateBroadsheet({ exam, version: newVersion, marksRows, dbClient: client });

      await writeAuditLog(client, {
        examId: exam.id, user: req.user,
        action: `Approved Correction Request. New version v${newVersion} created; previous versions preserved.`,
        previousValue: "correction_pending_hm", newValue: "published",
        ip: req.auditContext.ip, device: req.auditContext.device,
      });
    } else {
      await client.query(`UPDATE exams SET status = 'published' WHERE id = $1`, [exam.id]);
      await client.query(`UPDATE correction_requests SET status = 'rejected_headmaster', headmaster_decided_by = $1, headmaster_decided_at = now(), headmaster_decision_reason = $2 WHERE id = $3`, [req.user.id, reason, cr.id]);
      await writeAuditLog(client, { examId: exam.id, user: req.user, action: "Rejected Correction Request at final stage. Published record unchanged.", previousValue: "correction_pending_hm", newValue: "published", reason, ip: req.auditContext.ip, device: req.auditContext.device });
    }

    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (err) { await client.query("ROLLBACK"); next(err); } finally { client.release(); }
});

// ---------------------------------------------------------------
// Read endpoints
// ---------------------------------------------------------------
// ---------------------------------------------------------------
// Read endpoints
// ---------------------------------------------------------------
// List exams. Teachers see only their own; Administrator/Headmaster/
// Super Admin see everything, since they need visibility across the school.
router.get("/", async (req, res, next) => {
  try {
    const isStaff = ["administrator", "headmaster", "super_administrator"].includes(req.user.role);
    const { rows } = isStaff
      ? await pool.query(`SELECT e.*, u.name AS teacher_name FROM exams e JOIN users u ON u.id = e.teacher_id ORDER BY e.created_at DESC`)
      : await pool.query(`SELECT e.*, u.name AS teacher_name FROM exams e JOIN users u ON u.id = e.teacher_id WHERE e.teacher_id = $1 ORDER BY e.created_at DESC`, [req.user.id]);
    res.json(rows);
  } catch (err) { next(err); }
});

// Single exam with its current marks attached, for the detail view.
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

router.get("/:id/audit-log", requireRole("administrator", "headmaster", "super_administrator"), async (req, res, next) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM audit_log WHERE exam_id = $1 ORDER BY id ASC`, [req.params.id]);
    res.json(rows);
  } catch (err) { next(err); }
});

router.get("/:id/versions", requireAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM exam_versions WHERE exam_id = $1 ORDER BY version ASC`, [req.params.id]);
    res.json(rows);
  } catch (err) { next(err); }
});

// Lists the generated report cards for the exam's current version, each
// with a public verify link — this is what the dashboard shows staff so
// they can hand out / re-share the same QR-verified PDFs parents get.
router.get("/:id/report-cards", requireAuth, async (req, res, next) => {
  try {
    const { rows: examRows } = await pool.query(`SELECT current_version FROM exams WHERE id = $1`, [req.params.id]);
    if (!examRows[0]) return res.status(404).json({ error: "Examination not found." });

    const { rows } = await pool.query(
      `SELECT rc.qr_token, rc.generated_at, s.full_name
       FROM report_cards rc JOIN students s ON s.id = rc.student_id
       WHERE rc.exam_id = $1 AND rc.version = $2 ORDER BY s.full_name`,
      [req.params.id, examRows[0].current_version]
    );
    const base = process.env.PORTAL_BASE_URL || "";
    res.json(rows.map((r) => ({
      studentName: r.full_name,
      generatedAt: r.generated_at,
      verifyUrl: `${base}/verify/${r.qr_token}`,
      pdfUrl: `${base}/verify/${r.qr_token}/pdf`,
    })));
  } catch (err) { next(err); }
});

module.exports = { router, dispatchQueuedNotifications };
