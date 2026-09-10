const express = require("express");
const router = express.Router();
const rateLimit = require("express-rate-limit");
const { pool } = require("../db");

// Parent Portal has no login, so this is the only real defense against
// someone scripting through admission-number/phone combinations.
const lookupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: "Too many lookup attempts. Please wait 15 minutes and try again." },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Public lookup by admission number. Deliberately returns only exams that
 * are 'published' or 'locked' — a parent can never see a draft, a
 * submitted-but-unapproved mark, or anything mid-workflow, only the
 * official record. No authentication is required, matching how a real
 * parent portal link works (e.g. from an SMS), but this also means the
 * admission number itself is acting as the access key — worth upgrading
 * to a PIN or date-of-birth check before this handles real student data.
 */
// Strips everything but digits, then compares the last 9 digits — this
// tolerates the different ways the same Ghanaian number gets typed
// (0551234567, +233551234567, with spaces/dashes, etc.) without needing
// the parent to match formatting exactly.
function normalizePhone(p) {
  const digits = String(p || "").replace(/\D/g, "");
  return digits.slice(-9);
}

/**
 * Public lookup by admission number AND parent phone — both must match.
 * Deliberately returns the same generic error whether the admission
 * number doesn't exist or the phone doesn't match it, so a stranger
 * probing the endpoint can't tell which field was wrong and narrow
 * down a guess field-by-field. Only exams that are 'published' or
 * 'locked' are ever returned — never a draft or in-progress mark.
 */
router.get("/students/:admissionNo/results", lookupLimiter, async (req, res, next) => {
  const GENERIC_ERROR = "No results found for that admission number and phone number. Please check both and try again.";
  try {
    const { phone } = req.query;
    if (!phone) return res.status(400).json({ error: "Parent phone number is required." });

    const { rows: studentRows } = await pool.query(
      `SELECT * FROM students WHERE admission_no = $1`, [req.params.admissionNo]
    );
    const student = studentRows[0];
    if (!student || normalizePhone(student.parent_phone) !== normalizePhone(phone)) {
      return res.status(404).json({ error: GENERIC_ERROR });
    }

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

// ---------------------------------------------------------------
// Staff registration by SMS invite
// ---------------------------------------------------------------
const bcrypt = require("bcryptjs");
const { sendStaffRegisteredSms } = require("../services/mnotify");

const inviteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: "Too many attempts. Please wait 15 minutes and try again." },
  standardHeaders: true,
  legacyHeaders: false,
});

// Lets the registration page greet the staff member by name and confirm
// the link is still valid, without exposing anything else about the
// account. A missing/expired/already-used token all return the same
// generic error so a guessed token can't be distinguished from a real
// but expired one.
router.get("/staff-invite/:token", inviteLimiter, async (req, res, next) => {
  const GENERIC_ERROR = "This registration link is invalid or has expired.";
  try {
    const { rows } = await pool.query(
      `SELECT name, role FROM users
       WHERE invite_token = $1 AND invite_expires_at > now() AND password_hash IS NULL`,
      [req.params.token]
    );
    if (!rows[0]) return res.status(404).json({ error: GENERIC_ERROR });
    res.json({ name: rows[0].name, role: rows[0].role });
  } catch (err) { next(err); }
});

// Completes registration: the staff member sets a password, the account
// activates, and the invite token is cleared so the link can't be reused.
router.post("/staff-invite/:token", inviteLimiter, async (req, res, next) => {
  const GENERIC_ERROR = "This registration link is invalid or has expired.";
  const { password } = req.body;
  if (!password || password.length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters." });
  }
  try {
    const { rows: existing } = await pool.query(
      `SELECT id, name, phone FROM users
       WHERE invite_token = $1 AND invite_expires_at > now() AND password_hash IS NULL`,
      [req.params.token]
    );
    if (!existing[0]) return res.status(404).json({ error: GENERIC_ERROR });

    const passwordHash = await bcrypt.hash(password, 10);
    await pool.query(
      `UPDATE users SET password_hash = $1, active = TRUE, invite_token = NULL, invite_expires_at = NULL WHERE id = $2`,
      [passwordHash, existing[0].id]
    );

    const firstName = existing[0].name.split(" ").slice(1).join(" ") || existing[0].name;
    await sendStaffRegisteredSms({ to: existing[0].phone, firstName }).catch(() => {});

    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = { router };
