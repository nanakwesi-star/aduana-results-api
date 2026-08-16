const express = require("express");
const router = express.Router();
const multer = require("multer");
const XLSX = require("xlsx");

const { pool } = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

router.use(requireAuth);

// An Administrator (or Super Administrator) may always add students.
// A Teacher may only add students to a class they are the assigned
// Form Master of — that assignment lives on classes.form_master_id and
// is set/changed by the Admin in the Admin Panel.
async function canManageStudentsForClass(user, className) {
  if (["administrator", "super_administrator"].includes(user.role)) return true;
  if (user.role !== "teacher" || !className) return false;
  const { rows } = await pool.query(
    `SELECT 1 FROM classes WHERE name = $1 AND form_master_id = $2 LIMIT 1`,
    [className, user.id]
  );
  return rows.length > 0;
}

// Lets the frontend ask "can I add students to this class" before showing
// the Add Student / Bulk Upload UI, without duplicating the Form Master
// permission logic on the client (which could just be faked).
router.get("/can-manage", async (req, res, next) => {
  try {
    const allowed = await canManageStudentsForClass(req.user, req.query.class);
    res.json({ allowed });
  } catch (err) { next(err); }
});

// List students. Reviewer roles (Administrator/Headmaster/Super Admin) can
// see any approval status via ?status=; everyone else only ever sees
// Headmaster-approved students, so a pending addition stays invisible
// until it has actually been validated.
router.get("/", async (req, res, next) => {
  try {
    const { class: className, status } = req.query;
    const isReviewer = ["administrator", "headmaster", "super_administrator"].includes(req.user.role);
    const effectiveStatus = isReviewer ? (status || null) : "approved";

    const conditions = [];
    const params = [];
    if (className) { params.push(className); conditions.push(`class = $${params.length}`); }
    if (effectiveStatus) { params.push(effectiveStatus); conditions.push(`approval_status = $${params.length}`); }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const { rows } = await pool.query(`SELECT * FROM students ${where} ORDER BY class, full_name`, params);
    res.json(rows);
  } catch (err) { next(err); }
});

// Add a single student. Only an Administrator, or the Form Master of the
// target class, may do this. Every addition starts "pending" and stays
// invisible for marks entry until the Headmaster validates it.
router.post("/", async (req, res, next) => {
  const { fullName, class: className, admissionNo, parentPhone, parentWhatsapp } = req.body;
  if (!fullName || !className || !admissionNo) {
    return res.status(400).json({ error: "fullName, class, and admissionNo are required." });
  }

  const allowed = await canManageStudentsForClass(req.user, className);
  if (!allowed) {
    return res.status(403).json({ error: "Only the Administrator or this class's assigned Form Master may add students here." });
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO students (full_name, class, admission_no, parent_phone, parent_whatsapp, approval_status, added_by)
       VALUES ($1,$2,$3,$4,$5,'pending',$6) RETURNING *`,
      [fullName, className, admissionNo, parentPhone || null, parentWhatsapp || null, req.user.id]
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

// Bulk import from an uploaded Excel/CSV file. Same Admin / Form Master
// permission rule as the single-add route, checked per class encountered
// in the file (cached so repeated classes aren't re-queried), and every
// inserted row also starts "pending" — duplicates (by admission number)
// are reported back rather than silently overwritten, since a re-upload
// of the same file should be safe to run twice.
router.post("/bulk-upload", upload.single("file"), async (req, res, next) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded." });
  const defaultClass = req.body.class || null;
  const permissionCache = new Map();

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

      if (!permissionCache.has(className)) {
        permissionCache.set(className, await canManageStudentsForClass(req.user, className));
      }
      if (!permissionCache.get(className)) {
        results.errors.push({ row: i + 2, reason: `You do not have permission to add students to class "${className}".` });
        continue;
      }

      try {
        await pool.query(
          `INSERT INTO students (full_name, class, admission_no, parent_phone, parent_whatsapp, approval_status, added_by)
           VALUES ($1,$2,$3,$4,$5,'pending',$6)`,
          [fullName, className, admissionNo, row.parentPhone || null, row.parentWhatsapp || null, req.user.id]
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

// ---------------------------------------------------------------
// Headmaster validation of newly-added students
// ---------------------------------------------------------------

// List every student still waiting on a decision. Administrators and
// Super Admins can see this queue too (for visibility), but only the
// Headmaster can actually approve or reject.
router.get("/pending", requireRole("headmaster", "administrator", "super_administrator"), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT s.*, u.name AS added_by_name
       FROM students s LEFT JOIN users u ON u.id = s.added_by
       WHERE s.approval_status = 'pending' ORDER BY s.created_at ASC`
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.post("/:id/approve", requireRole("headmaster"), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `UPDATE students SET approval_status = 'approved', approved_by = $1, approved_at = now()
       WHERE id = $2 AND approval_status = 'pending' RETURNING *`,
      [req.user.id, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: "No pending student found with that ID." });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

router.post("/:id/reject", requireRole("headmaster"), async (req, res, next) => {
  const { reason } = req.body;
  if (!reason?.trim()) return res.status(400).json({ error: "A reason is required to reject a student addition." });
  try {
    const { rows } = await pool.query(
      `UPDATE students SET approval_status = 'rejected', approved_by = $1, approved_at = now(), rejection_reason = $2
       WHERE id = $3 AND approval_status = 'pending' RETURNING *`,
      [req.user.id, reason, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: "No pending student found with that ID." });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

module.exports = { router };
