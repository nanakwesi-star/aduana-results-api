const axios = require("axios");

const MNOTIFY_API_KEY = process.env.MNOTIFY_API_KEY;
const SENDER_ID = "AduanaModel";
const BASE_URL = "https://api.mnotify.com/api";

/**
 * Sends the "your child's report is ready" SMS via mNotify (BMS Africa),
 * reusing the same sender ID already registered for the school's existing
 * results system.
 */
async function sendResultSms({ to, studentName, className, portalLink }) {
  const message =
    `Dear Parent, ${studentName}'s (${className}) exam report is now available on the Parent Portal: ${portalLink}. - Aduana Model JHS`;

  const { data } = await axios.post(`${BASE_URL}/sms/quick`, {
    recipient: [to],
    sender: SENDER_ID,
    message,
    is_schedule: false,
  }, {
    params: { key: MNOTIFY_API_KEY },
  });

  return { providerRef: data?.summary?.message_id || data?.message_id || null, raw: data };
}

/**
 * WhatsApp via mNotify's WhatsApp Business channel. If the school hasn't
 * provisioned a WhatsApp sender yet, this call should be feature-flagged
 * off and fall back to SMS-only until that's set up.
 */
async function sendResultWhatsapp({ to, studentName, className, portalLink }) {
  const { data } = await axios.post(`${BASE_URL}/whatsapp/send`, {
    recipient: to,
    template: "result_published",
    params: [studentName, className, portalLink],
  }, {
    params: { key: MNOTIFY_API_KEY },
  });

  return { providerRef: data?.message_id || null, raw: data };
}

async function notifyHeadmasterOfUnlock({ examId, reason, unlockedBy }) {
  const { pool } = require("../db");
  const { rows } = await pool.query(`SELECT phone FROM users WHERE role = 'headmaster' AND active = TRUE`);
  const message = `ALERT: Exam ${examId} was emergency-unlocked by ${unlockedBy}. Reason: ${reason}`;
  for (const hm of rows) {
    if (!hm.phone) continue;
    await axios.post(`${BASE_URL}/sms/quick`, {
      recipient: [hm.phone], sender: SENDER_ID, message, is_schedule: false,
    }, { params: { key: MNOTIFY_API_KEY } }).catch(() => {});
  }
}

/**
 * Sent to the student's guardian once the Headmaster validates a PTA
 * dues payment (the final step of the collector -> Admin -> Headmaster
 * chain). States who recorded it, how much, when, and — since a term's
 * GHS 30 due can be paid in installments — either that this closes out
 * the term or exactly what's still owed.
 */
async function sendPtaPaymentSms({ to, studentName, teacherName, amount, datePaid, term, isFinalPayment, balance }) {
  const message = isFinalPayment
    ? `Dear Parent, GHS ${amount} PTA dues for ${studentName} recorded by ${teacherName} on ${datePaid}. This completes payment for ${term}. - Aduana Model JHS`
    : `Dear Parent, GHS ${amount} PTA dues for ${studentName} recorded by ${teacherName} on ${datePaid}. Balance remaining for ${term}: GHS ${balance}. - Aduana Model JHS`;

  const { data } = await axios.post(`${BASE_URL}/sms/quick`, {
    recipient: [to],
    sender: SENDER_ID,
    message,
    is_schedule: false,
  }, {
    params: { key: MNOTIFY_API_KEY },
  });

  return { providerRef: data?.summary?.message_id || data?.message_id || null, raw: data };
}

module.exports = { sendResultSms, sendResultWhatsapp, notifyHeadmasterOfUnlock, sendPtaPaymentSms, SENDER_ID };
