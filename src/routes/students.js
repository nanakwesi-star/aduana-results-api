const express = require("express");
const router = express.Router();
const multer = require("multer");
const XLSX = require("xlsx");
const { pool } = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

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

// Normalizes a header like "Admission No." or "admission_no" down to a
// consistent key, so the template is forgiving of small formatting
// differences a non-technical staff member might introduce in Excel.
function normalizeHeader(h) {
  return String(h || "").toLowerCase().replace(/[^a-z]/g, "");
}
const HEADER_MAP = {
  fullname: "fullName", name: "fullName", studentname: "fullName",
  admissionno: "admissionNo", admissionnumber: "admissionNo",
  class: "class",
  parentphone: "parentPhone", phone: "parentPhone", parentsms: "parentPhone",
  parentwhatsapp: "parentWhatsapp", whatsapp: "parentWhatsapp",
};

// Bulk import from an uploaded Excel/CSV file. Every row becomes one
// students.insert; duplicates (by admission number) are reported back
// rather than silently overwritten, since a re-upload of the same file
// should be safe to run twice.
router.post("/bulk-upload", requireRole("teacher", "administrator"), upload.single("file"), async (req, res, next) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded." });
  const defaultClass = req.body.class || null;

  try {
    const workbook = XLSX.read(req.file.buffer, { type: "buffer" });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rawRows = XLSX.utils.sheet_to_json(sheet, { defval: "" });

    const results = { added: [], skipped: [], errors: [] };

    for (let i = 0; i < rawRows.length; i++) {
      const raw = rawRows[i];
      const row = {};
      for (const key of Object.keys(raw)) {
        const mapped = HEADER_MAP[normalizeHeader(key)];
        if (mapped) row[mapped] = String(raw[key]).trim();
      }
      const fullName = row.fullName;
      const admissionNo = row.admissionNo;
      const className = row.class || defaultClass;

      if (!fullName || !admissionNo || !className) {
        results.errors.push({ row: i + 2, reason: "Missing required field (name, admission no, or class)." });
        continue;
      }

      try {
        await pool.query(
          `INSERT INTO students (full_name, class, admission_no, parent_phone, parent_whatsapp)
           VALUES ($1,$2,$3,$4,$5)`,
          [fullName, className, admissionNo, row.parentPhone || null, row.parentWhatsapp || null]
        );
        results.added.push(admissionNo);
      } catch (e) {
        if (e.code === "23505") { // unique_violation on admission_no
          results.skipped.push({ row: i + 2, admissionNo, reason: "Admission number already exists." });
        } else {
          results.errors.push({ row: i + 2, reason: e.message });
        }
      }
    }

    res.json(results);
  } catch (err) { next(err); }
});

module.exports = { router };

