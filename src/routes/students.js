const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");

router.use(requireAuth);

router.get("/", async (req, res, next) => {
  try {
    const { class: className } = req.query;
    const { rows } = className
      ? await pool.query(`SELECT * FROM students WHERE class = $1 ORDER BY full_name`, [className])
      : await pool.query(`SELECT * FROM students ORDER BY class, full_name`);
    res.json(rows);
  } catch (err) { next(err); }
});

router.post("/", requireRole("teacher", "administrator"), async (req, res, next) => {
  const { fullName, class: className, admissionNo, parentPhone, parentWhatsapp } = req.body;
  if (!fullName || !className || !admissionNo) {
    return res.status(400).json({ error: "fullName, class, and admissionNo are required." });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO students (full_name, class, admission_no, parent_phone, parent_whatsapp)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [fullName, className, admissionNo, parentPhone || null, parentWhatsapp || null]
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

module.exports = { router };
