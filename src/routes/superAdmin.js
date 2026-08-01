const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const { requireAuth, requireRole, captureRequestContext } = require("../middleware/auth");
const { writeAuditLog } = require("../services/auditLog");
const { notifyHeadmasterOfUnlock } = require("../services/mnotify"); // see note below

router.use(requireAuth, captureRequestContext, requireRole("super_administrator"));

// Only this role, and only this route, can ever move an exam out of
// 'locked'. There is no other code path in the application that changes
// exams.status away from 'locked'.
router.post("/exams/:id/emergency-unlock", async (req, res, next) => {
  const { reason } = req.body;
  if (!reason?.trim()) return res.status(400).json({ error: "A written reason is mandatory to unlock an exam." });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(`SELECT * FROM exams WHERE id = $1`, [req.params.id]);
    const exam = rows[0];
    if (!exam) throw { status: 404, message: "Examination not found." };
    if (exam.status !== "locked") throw { status: 409, message: "Only a permanently locked exam can be emergency-unlocked." };

    const newLockAt = new Date(Date.now() + 21 * 24 * 60 * 60 * 1000);

    await client.query(
      `UPDATE exams SET status = 'published', lock_at = $1, emergency_unlocked = TRUE, locked_at = NULL WHERE id = $2`,
      [newLockAt, exam.id]
    );
    await client.query(
      `INSERT INTO emergency_unlocks (exam_id, super_admin_id, reason, new_lock_at) VALUES ($1,$2,$3,$4)`,
      [exam.id, req.user.id, reason, newLockAt]
    );
    await writeAuditLog(client, {
      examId: exam.id, user: req.user,
      action: "EMERGENCY UNLOCK performed on a permanently locked exam. A fresh 21-day correction window has been opened. This action is permanent in the audit trail and cannot be deleted.",
      previousValue: "locked", newValue: "published (reopened)", reason,
      ip: req.auditContext.ip, device: req.auditContext.device,
    });

    await client.query("COMMIT");

    // Best-effort — failure here must never roll back the unlock itself,
    // since the unlock and its audit record are the source of truth.
    notifyHeadmasterOfUnlock?.({ examId: exam.id, reason, unlockedBy: req.user.name }).catch(() => {});

    res.json({ ok: true, status: "published", lockAt: newLockAt });
  } catch (err) { await client.query("ROLLBACK"); next(err); } finally { client.release(); }
});

module.exports = { router };
