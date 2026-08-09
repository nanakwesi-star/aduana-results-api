const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");
const { pool } = require("../db");

// Much stricter than the app-wide limiter: login attempts are a classic
// brute-force target, so this caps guesses per IP independently of
// however much other traffic that IP is generating elsewhere.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: "Too many sign-in attempts. Please wait 15 minutes and try again." },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Real login, unified across every role. Staff and parents live in the
 * `users` table; students have their credentials directly on their own
 * `students` row instead of a separate account table, since a student's
 * "account" and their academic record are naturally the same thing.
 * Either way, the password is only ever compared as a bcrypt hash, and
 * a failed attempt never reveals which table (or whether an account)
 * matched, so this can't be used to enumerate real emails.
 */
router.post("/login", loginLimiter, async (req, res, next) => {
  const GENERIC_ERROR = "Incorrect email or password.";
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Email and password are required." });
  const normalizedEmail = email.toLowerCase().trim();

  try {
    const { rows: staffRows } = await pool.query(`SELECT * FROM users WHERE email = $1 AND active = TRUE`, [normalizedEmail]);
    const staffUser = staffRows[0];
    if (staffUser) {
      const valid = await bcrypt.compare(password, staffUser.password_hash);
      if (!valid) return res.status(401).json({ error: GENERIC_ERROR });
      const token = jwt.sign({ id: staffUser.id, name: staffUser.name, role: staffUser.role }, process.env.JWT_SECRET, { expiresIn: "12h" });
      return res.json({ token, user: { id: staffUser.id, name: staffUser.name, role: staffUser.role, email: staffUser.email } });
    }

    const { rows: studentRows } = await pool.query(
      `SELECT * FROM students WHERE email = $1 AND active = TRUE AND password_hash IS NOT NULL`, [normalizedEmail]
    );
    const student = studentRows[0];
    if (student) {
      const valid = await bcrypt.compare(password, student.password_hash);
      if (!valid) return res.status(401).json({ error: GENERIC_ERROR });
      const token = jwt.sign({ id: student.id, name: student.full_name, role: "student" }, process.env.JWT_SECRET, { expiresIn: "12h" });
      return res.json({ token, user: { id: student.id, name: student.full_name, role: "student", email: student.email } });
    }

    return res.status(401).json({ error: GENERIC_ERROR });
  } catch (err) { next(err); }
});

module.exports = { router };
