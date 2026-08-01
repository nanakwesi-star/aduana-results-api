const cron = require("node-cron");
const { pool } = require("../db");
const { writeAuditLog } = require("./auditLog");

const SYSTEM_USER = { id: null, name: "SYSTEM", role: "super_administrator" };

/**
 * Runs every 5 minutes and locks any published exam whose lock_at has
 * passed. This is the ONLY place in the codebase that sets status =
 * 'locked' — no user-facing route can do it directly, which is what
 * makes the lock actually automatic rather than something a role could
 * accidentally (or deliberately) skip.
 */
async function runLockSweep() {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT * FROM exams WHERE status = 'published' AND lock_at IS NOT NULL AND lock_at <= now()`
    );
    for (const exam of rows) {
      await client.query("BEGIN");
      await client.query(`UPDATE exams SET status = 'locked', locked_at = now() WHERE id = $1`, [exam.id]);
      await writeAuditLog(client, {
        examId: exam.id, user: SYSTEM_USER,
        action: "Examination automatically and permanently locked at the end of the 21-day validation window.",
        previousValue: "published", newValue: "locked",
        ip: null, device: "scheduler",
      });
      await client.query("COMMIT");
    }
    if (rows.length) console.log(`Lock sweep: locked ${rows.length} exam(s).`);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("Lock sweep failed:", err);
  } finally {
    client.release();
  }
}

function startLockScheduler() {
  cron.schedule("*/5 * * * *", runLockSweep);
  console.log("Lock scheduler started (runs every 5 minutes).");
}

module.exports = { startLockScheduler, runLockSweep };
