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
 * Real login. Compares the submitted password against the bcrypt hash
 * stored in users.password_hash — the plaintext password is never
 * stored or logged anywhere, only ever hashed. Returns the same generic
 * error whether the email doesn't exist or the password is wrong, so a
 * failed attempt can't be used to enumerate which staff emails exist.
 */
router.post("/login", loginLimiter, async (req, res, next) => {
  const GENERIC_ERROR = "Incorrect email or password.";
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Email and password are required." });

  try {
    const { rows } = await pool.query(`SELECT * FROM users WHERE email = $1 AND active = TRUE`, [email.toLowerCase().trim()]);
    const user = rows[0];
    if (!user) return res.status(401).json({ error: GENERIC_ERROR });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: GENERIC_ERROR });

    const token = jwt.sign(
      { id: user.id, name: user.name, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: "12h" }
    );

    res.json({ token, user: { id: user.id, name: user.name, role: user.role, email: user.email } });
  } catch (err) { next(err); }
});

module.exports = { router };
