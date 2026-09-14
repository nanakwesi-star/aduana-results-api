const express = require("express");
const router = express.Router();
const multer = require("multer");

const { pool } = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB — plenty for a scanned timetable
  fileFilter: (req, file, cb) => {
    if (file.mimetype !== "application/pdf") {
      const err = new Error("Only PDF files are allowed.");
      err.status = 400;
      return cb(err);
    }
    cb(null, true);
  },
});

router.use(requireAuth);

// Admin/Headmaster/Super Admin uploads (or replaces) a timetable PDF for a
// specific teacher. One timetable per teacher — teacher_id is UNIQUE, so a
// re-upload overwrites the previous file instead of creating a duplicate.
router.post("/:teacherId", requireRole("administrator", "headmaster", "super_administrator"), upload.single("file"), async (req, res, next) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded." });
  try {
    const { rows: teacherRows } = await pool.query(
      `SELECT id FROM users WHERE id = $1 AND role = 'teacher'`,
      [req.params.teacherId]
    );
    if (!teacherRows[0]) return res.status(404).json({ error: "Teacher not found." });

    await pool.query(
      `INSERT INTO teacher_timetables (teacher_id, file_name, file_data, uploaded_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (teacher_id) DO UPDATE
       SET file_name = EXCLUDED.file_name, file_data = EXCLUDED.file_data,
           uploaded_by = EXCLUDED.uploaded_by, uploaded_at = now()`,
      [req.params.teacherId, req.file.originalname, req.file.buffer, req.user.id]
    );
    res.status(201).json({ ok: true });
  } catch (err) { next(err); }
});

// Admin view: which teachers currently have a timetable on file, so the
// upload screen can show "Uploaded" vs "Not yet uploaded" per teacher
// without pulling every PDF's bytes just to check.
router.get("/", requireRole("administrator", "headmaster", "super_administrator"), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT teacher_id, file_name, uploaded_at FROM teacher_timetables`
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// Teacher checks whether they have a timetable uploaded (metadata only).
router.get("/mine", requireRole("teacher"), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT file_name, uploaded_at FROM teacher_timetables WHERE teacher_id = $1`,
      [req.user.id]
    );
    res.json(rows[0] || null);
  } catch (err) { next(err); }
});

// Teacher downloads their own timetable PDF — never anyone else's, since
// this always looks up by req.user.id from the login token, not a param.
router.get("/mine/download", requireRole("teacher"), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT file_name, file_data FROM teacher_timetables WHERE teacher_id = $1`,
      [req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ error: "No timetable has been uploaded for you yet." });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${rows[0].file_name}"`);
    res.send(rows[0].file_data);
  } catch (err) { next(err); }
});

module.exports = { router };
