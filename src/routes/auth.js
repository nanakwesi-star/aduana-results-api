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
 * `users` table; students have their
