const express = require("express");
const router = express.Router();

const { pool } = require("../db");
const { requireAuth, requireRole, captureRequestContext } = require("../middleware/auth");
const { writeAuditLog } = require("../services/auditLog");
const { sendPtaPaymentSms } = require("../services/mnotify");

// Policy, not data — a fee change is a one-line edit here, not a migration.
const TERM_FEE = 30;
const TERMS_PER_YEAR = 3;
const YEARLY_FEE = TERM_FEE * TERMS_PER_YEAR; // 90

router.use(requireAuth, captureRequestContext);

// ---------------------------------------------------------------
// Admin: assign / revoke / list collectors
// ---------------------------------------------------------------

// Grant a teacher permission to collect PTA dues. classId is optional —
// omit it to let them collect for any class; set it to restrict them to
// one class (their own, typically). Re-assigning the same teacher to the
// same class just re-activates the existing row rather than duplicating it.
router.post("/collectors", requireRole("administrator", "super_administrator"), async (req, res, next) => {
  const { teacherId, classId } = req.body;
  if (!teacherId) return res.status(400).json({ error: "teacherId is required." });

  try {
    const { rows: teacherRows } = await pool.query(
      `SELECT id, name FROM users WHERE id = $1 AND role = 'teacher' AND active = TRUE`, [teacherId]
    );
    if (!teacherRows[0]) throw { status: 404, message: "Teacher not found or not an active teacher account." };

    const { rows } = await pool.query(
      `INSERT INTO pta_collectors (teacher_id, class_id, assigned_by, active)
       VALUES ($1,$2,$3,TRUE)
       ON CONFLICT (teacher_id, class_id) DO UPDATE SET active = TRUE, assigned_by = EXCLUDED.assigned_by
       RETURNING *`,
      [teacherId, classId || null, req.user.id]
    );

    await writeAuditLog(pool, {
      examId: null, user: req.user,
      action: `Assigned ${teacherRows[0].name} as PTA dues collector${classId ? " for one class" : " (all classes)"}.`,
      previousValue: null, newValue: rows[0].id,
      ip: req.auditContext.ip, device: req.auditContext.device,
    }).catch(() => {});

    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

// Revoke — kept as an inactive row, not deleted, so past payments they
// collected still trace back to a real audit record.
router.delete("/collectors/:id", requireRole("administrator", "super_administrator"), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `UPDATE pta_collectors SET active = FALSE WHERE id = $1 RETURNING *`, [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: "Collector assignment not found." });

    await writeAuditLog(pool, {
      examId: null, user: req.user, action: "Revoked PTA dues collector permission.",
      previousValue: rows[0].id, newValue: null,
      ip: req.auditContext.ip, device: req.auditContext.device,
    }).catch(() => {});

    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.get("/collectors", requireRole("administrator", "super_administrator", "headmaster"), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT pc.id, pc.teacher_id, pc.class_id, pc.active, pc.created_at,
              u.name AS teacher_name, c.name AS class_name
       FROM pta_collectors pc
       JOIN users u ON u.id = pc.teacher_id
       LEFT JOIN classes c ON c.id = pc.class_id
       ORDER BY pc.active DESC, u.name`
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// Lets the frontend show/hide the "Accounts" menu for the signed-in
// teacher without duplicating the permission check client-side.
router.get("/my-status", requireRole("teacher"), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT pc.class_id, c.name AS class_name
       FROM pta_collectors pc LEFT JOIN classes c ON c.id = pc.class_id
       WHERE pc.teacher_id = $1 AND pc.active = TRUE`,
      [req.user.id]
    );
    res.json({ isCollector: rows.length > 0, scopes: rows });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------

async function assertIsActiveCollectorForStudent(client, teacherId, studentId) {
  const { rows: studentRows } = await client.query(`SELECT id, class, full_name, parent_phone FROM students WHERE id = $1`, [studentId]);
  const student = studentRows[0];
  if (!student) throw { status: 404, message: "Student not found." };

  const { rows: scopeRows } = await client.query(
    `SELECT pc.class_id, c.name AS class_name FROM pta_collectors pc
     LEFT JOIN classes c ON c.id = pc.class_id
     WHERE pc.teacher_id = $1 AND pc.active = TRUE`,
    [teacherId]
  );
  if (scopeRows.length === 0) throw { status: 403, message: "You are not currently assigned to collect PTA dues." };

  const allowed = scopeRows.some((s) => s.class_id === null || s.class_name === student.class);
  if (!allowed) throw { status: 403, message: `You are only permitted to collect PTA dues for your assigned class, not ${student.class}.` };

  return student;
}

async function getCurrentTerm(client) {
  const { rows } = await client.query(`SELECT term, academic_year FROM term_settings WHERE id = 1`);
  if (!rows[0]) throw { status: 409, message: "No current term is set. Ask an Administrator to set the current term first." };
  return rows[0];
}

// Sum of already-RECORDED (validated) payments for this student/term —
// the only status that counts toward the balance, since anything still
// pending_admin/pending_headmaster hasn't been confirmed yet.
async function getRecordedTotal(client, studentId, term, academicYear) {
  const { rows } = await client.query(
    `SELECT COALESCE(SUM(amount), 0)::numeric AS total FROM pta_payments
     WHERE student_id = $1 AND term = $2 AND academic_year = $3 AND status = 'recorded'`,
    [studentId, term, academicYear]
  );
  return Number(rows[0].total);
}

// ---------------------------------------------------------------
// Collector (teacher): record & submit a payment
// ---------------------------------------------------------------

router.post("/payments", requireRole("teacher"), async (req, res, next) => {
  const { studentId, amount } = req.body;
  const numericAmount = Number(amount);
  if (!studentId || !numericAmount || numericAmount <= 0) {
    return res.status(400).json({ error: "studentId and a positive amount are required." });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const student = await assertIsActiveCollectorForStudent(client, req.user.id, studentId);
    const { term, academic_year: academicYear } = await getCurrentTerm(client);

    const alreadyRecorded = await getRecordedTotal(client, studentId, term, academicYear);
    // Pending (not yet validated) amounts also block over-collection, so
    // two collectors can't both submit and double-count the same balance.
    const { rows: pendingRows } = await client.query(
      `SELECT COALESCE(SUM(amount), 0)::numeric AS total FROM pta_payments
       WHERE student_id = $1 AND term = $2 AND academic_year = $3
         AND status IN ('pending_admin', 'pending_headmaster')`,
      [studentId, term, academicYear]
    );
    const alreadyPending = Number(pendingRows[0].total);

    if (alreadyRecorded + alreadyPending + numericAmount > TERM_FEE) {
      const remaining = Math.max(0, TERM_FEE - alreadyRecorded - alreadyPending);
      throw { status: 409, message: `This would exceed the GHS ${TERM_FEE} due for ${term}. Remaining balance is GHS ${remaining.toFixed(2)}.` };
    }

    const { rows } = await client.query(
      `INSERT INTO pta_payments (student_id, term, academic_year, amount, collected_by, status)
       VALUES ($1,$2,$3,$4,$5,'pending_admin') RETURNING *`,
      [studentId, term, academicYear, numericAmount, req.user.id]
    );

    await writeAuditLog(client, {
      examId: null, user: req.user,
      action: `Recorded PTA dues payment of GHS ${numericAmount} for ${student.full_name} (${term} ${academicYear}). Submitted for Admin review.`,
      previousValue: null, newValue: rows[0].id,
      ip: req.auditContext.ip, device: req.auditContext.device,
    });

    await client.query("COMMIT");
    res.status(201).json(rows[0]);
  } catch (err) { await client.query("ROLLBACK"); next(err); } finally { client.release(); }
});

// A collector's own submission history.
router.get("/payments/mine", requireRole("teacher"), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT pp.*, s.full_name AS student_name, s.admission_no, s.class
       FROM pta_payments pp JOIN students s ON s.id = pp.student_id
       WHERE pp.collected_by = $1 ORDER BY pp.created_at DESC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// A student's payment ledger — what's been recorded, what's pending, and
// the running balance for the current term. Any collector, Admin, or
// Headmaster can look this up (e.g. before collecting, to check what's
// already been paid).
router.get("/students/:studentId/ledger", requireRole("teacher", "administrator", "super_administrator", "headmaster"), async (req, res, next) => {
  try {
    const { rows: studentRows } = await pool.query(`SELECT id, full_name, class, admission_no FROM students WHERE id = $1`, [req.params.studentId]);
    if (!studentRows[0]) return res.status(404).json({ error: "Student not found." });

    const { rows: payments } = await pool.query(
      `SELECT pp.*, u.name AS collected_by_name
       FROM pta_payments pp JOIN users u ON u.id = pp.collected_by
       WHERE pp.student_id = $1 ORDER BY pp.academic_year DESC, pp.term, pp.created_at`,
      [req.params.studentId]
    );

    const { rows: termRows } = await pool.query(`SELECT term, academic_year FROM term_settings WHERE id = 1`);
    const current = termRows[0];
    const recordedThisTerm = current
      ? payments.filter((p) => p.status === "recorded" && p.term === current.term && p.academic_year === current.academic_year)
        .reduce((sum, p) => sum + Number(p.amount), 0)
      : 0;

    res.json({
      student: studentRows[0],
      payments,
      currentTerm: current,
      balanceThisTerm: current ? Math.max(0, TERM_FEE - recordedThisTerm) : null,
      termFee: TERM_FEE,
      yearlyFee: YEARLY_FEE,
    });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------
// Admin: review queue, forward to Headmaster, or reject to collector
// ---------------------------------------------------------------

router.get("/payments", requireRole("administrator", "super_administrator", "headmaster"), async (req, res, next) => {
  try {
    const isHeadmaster = req.user.role === "headmaster";
    const status = req.query.status || (isHeadmaster ? "pending_headmaster" : "pending_admin");

    const { rows } = await pool.query(
      `SELECT pp.*, s.full_name AS student_name, s.admission_no, s.class, u.name AS collected_by_name
       FROM pta_payments pp
       JOIN students s ON s.id = pp.student_id
       JOIN users u ON u.id = pp.collected_by
       WHERE pp.status = $1
       ORDER BY pp.created_at ASC`,
      [status]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

async function getPaymentOr404(client, id) {
  const { rows } = await client.query(
    `SELECT pp.*, s.full_name AS student_name, s.parent_phone
     FROM pta_payments pp JOIN students s ON s.id = pp.student_id WHERE pp.id = $1`,
    [id]
  );
  if (!rows[0]) throw { status: 404, message: "Payment record not found." };
  return rows[0];
}

router.post("/payments/:id/forward", requireRole("administrator", "super_administrator"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const payment = await getPaymentOr404(client, req.params.id);
    if (payment.status !== "pending_admin") throw { status: 409, message: "Only payments awaiting Admin review can be forwarded." };

    await client.query(
      `UPDATE pta_payments SET status = 'pending_headmaster', admin_forwarded_by = $1, admin_forwarded_at = now() WHERE id = $2`,
      [req.user.id, payment.id]
    );
    await writeAuditLog(client, {
      examId: null, user: req.user,
      action: `Forwarded PTA dues payment (GHS ${payment.amount}, ${payment.student_name}) to Headmaster.`,
      previousValue: "pending_admin", newValue: "pending_headmaster",
      ip: req.auditContext.ip, device: req.auditContext.device,
    });

    await client.query("COMMIT");
    res.json({ ok: true, status: "pending_headmaster" });
  } catch (err) { await client.query("ROLLBACK"); next(err); } finally { client.release(); }
});

router.post("/payments/:id/reject", requireRole("administrator", "super_administrator"), async (req, res, next) => {
  const { reason } = req.body;
  if (!reason?.trim()) return res.status(400).json({ error: "A reason is required to reject a payment back to the collector." });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const payment = await getPaymentOr404(client, req.params.id);
    if (payment.status !== "pending_admin") throw { status: 409, message: "Only payments awaiting Admin review can be rejected." };

    await client.query(`UPDATE pta_payments SET status = 'rejected_admin', rejection_reason = $1 WHERE id = $2`, [reason, payment.id]);
    await writeAuditLog(client, {
      examId: null, user: req.user,
      action: `Rejected PTA dues payment (GHS ${payment.amount}, ${payment.student_name}) back to collector.`,
      previousValue: "pending_admin", newValue: "rejected_admin", reason,
      ip: req.auditContext.ip, device: req.auditContext.device,
    });

    await client.query("COMMIT");
    res.json({ ok: true, status: "rejected_admin" });
  } catch (err) { await client.query("ROLLBACK"); next(err); } finally { client.release(); }
});

// ---------------------------------------------------------------
// Headmaster: validate (final) or reject back to Admin
// ---------------------------------------------------------------

router.post("/payments/:id/validate", requireRole("headmaster"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const payment = await getPaymentOr404(client, req.params.id);
    if (payment.status !== "pending_headmaster") throw { status: 409, message: "Only payments awaiting Headmaster validation can be validated." };

    await client.query(
      `UPDATE pta_payments SET status = 'recorded', headmaster_validated_by = $1, headmaster_validated_at = now() WHERE id = $2`,
      [req.user.id, payment.id]
    );

    const totalRecorded = await getRecordedTotal(client, payment.student_id, payment.term, payment.academic_year);
    const isFinalPayment = totalRecorded >= TERM_FEE;
    const balance = Math.max(0, TERM_FEE - totalRecorded);

    const { rows: collectorRows } = await client.query(`SELECT name FROM users WHERE id = $1`, [payment.collected_by]);
    const teacherName = collectorRows[0]?.name || "a teacher";

    await writeAuditLog(client, {
      examId: null, user: req.user,
      action: `Validated PTA dues payment (GHS ${payment.amount}, ${payment.student_name}, ${payment.term} ${payment.academic_year}). Recorded.`,
      previousValue: "pending_headmaster", newValue: "recorded",
      ip: req.auditContext.ip, device: req.auditContext.device,
    });

    await client.query("COMMIT");
    res.json({ ok: true, status: "recorded", isFinalPayment, balance });

    // SMS is sent after commit, same reasoning as exam publish notifications:
    // the payment record itself must never depend on a third-party API call
    // succeeding. A failure here is logged to the row but doesn't roll back
    // the validation.
    if (payment.parent_phone) {
      try {
        const result = await sendPtaPaymentSms({
          to: payment.parent_phone,
          studentName: payment.student_name,
          teacherName,
          amount: Number(payment.amount).toFixed(2),
          datePaid: new Date().toLocaleDateString("en-GB", { year: "numeric", month: "short", day: "2-digit" }),
          term: `${payment.term} ${payment.academic_year}`,
          isFinalPayment,
          balance: balance.toFixed(2),
        });
        await pool.query(`UPDATE pta_payments SET sms_status = 'sent', sms_provider_ref = $1 WHERE id = $2`, [result.providerRef, payment.id]);
      } catch (e) {
        await pool.query(`UPDATE pta_payments SET sms_status = 'failed', sms_error = $1 WHERE id = $2`, [e.message, payment.id]);
      }
    } else {
      await pool.query(`UPDATE pta_payments SET sms_status = 'failed', sms_error = 'No parent phone number on file.' WHERE id = $1`, [payment.id]);
    }
  } catch (err) { await client.query("ROLLBACK"); next(err); } finally { client.release(); }
});

router.post("/payments/:id/hm-reject", requireRole("headmaster"), async (req, res, next) => {
  const { reason } = req.body;
  if (!reason?.trim()) return res.status(400).json({ error: "A reason is required to reject a payment back to the Administrator." });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const payment = await getPaymentOr404(client, req.params.id);
    if (payment.status !== "pending_headmaster") throw { status: 409, message: "Only payments awaiting Headmaster validation can be returned." };

    await client.query(`UPDATE pta_payments SET status = 'rejected_headmaster', rejection_reason = $1 WHERE id = $2`, [reason, payment.id]);
    await writeAuditLog(client, {
      examId: null, user: req.user,
      action: `Returned PTA dues payment (GHS ${payment.amount}, ${payment.student_name}) to Administrator.`,
      previousValue: "pending_headmaster", newValue: "rejected_headmaster", reason,
      ip: req.auditContext.ip, device: req.auditContext.device,
    });

    await client.query("COMMIT");
    res.json({ ok: true, status: "rejected_headmaster" });
  } catch (err) { await client.query("ROLLBACK"); next(err); } finally { client.release(); }
});

module.exports = { router, TERM_FEE, YEARLY_FEE };
