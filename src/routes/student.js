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

// A class's level (1/2/3) plus the current academic year tells us which
// year that class's students were admitted — level 1 was admitted this
// year, level 2 one year ago, level 3 two years ago. This is computed
// once, at the moment a student is added, and then stored permanently on
// the student — it must NOT be recalculated later, since a class's level
// changes every year at promotion but a student's admission year never does.
async function getClassInfo(className) {
  const { rows } = await pool.query(`SELECT level, academic_year FROM classes WHERE name = $1`, [className]);
  return rows[0] || null;
}
function admissionYearFor(classInfo) {
  return classInfo.academic_year - (classInfo.level - 1);
}

// Atomically hands out the next sequential number for a given admission
// year (starting at 1 the first time that year is used). The INSERT ON
// CONFLICT is a single atomic database step, so two people bulk-uploading
// at the same moment can never be handed the same number.
async function nextStudentNumber(admissionYear) {
  const { rows } = await pool.query(
    `INSERT INTO student_number_counters (admission_year, last_number)
     VALUES ($1, 1)
     ON CONFLICT (admission_year) DO UPDATE SET last_number = student_number_counters.last_number + 1
     RETURNING last_number`,
    [admissionYear]
  );
  const yy = String(admissionYear).slice(-2);
  return `AMJ-${yy}-${String(rows[0].last_number).padStart(3, "0")}`;
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
  const { fullName, class: className, parentPhone, parentWhatsapp, sex } = req.body;
  if (!fullName || !className) {
    return res.status(400).json({ error: "Full name and class are required." });
  }
  if (sex && !["M", "F"].includes(sex)) {
    return res.status(400).json({ error: "sex must be 'M' or 'F'." });
  }

  const allowed = await canManageStudentsForClass(req.user, className);
  if (!allowed) {
    return res.status(403).json({ error: "Only the Administrator or this class's assigned Form Master may add students here." });
  }

  const classInfo = await getClassInfo(className);
  if (!classInfo || !classInfo.level) {
    return res.status(400).json({ error: `Class "${className}" has no level set yet — ask an Administrator to set its level (JHS 1/2/3) before adding students.` });
  }
  const admissionYear = admissionYearFor(classInfo);
  const admissionNo = await nextStudentNumber(admissionYear);

  try {
    const { rows } = await pool.query(
      `INSERT INTO students (full_name, class, admission_no, admission_year, parent_phone, parent_whatsapp, sex, approval_status, added_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8) RETURNING *`,
      [fullName, className, admissionNo, admissionYear, parentPhone || null, parentWhatsapp || null, sex || null, req.user.id]
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
  class: "class",
  parentphone: "parentPhone", phone: "parentPhone", parentsms: "parentPhone",
  parentwhatsapp: "parentWhatsapp", whatsapp: "parentWhatsapp",
  sex: "sex", gender: "sex",
};

// Turns whatever a staff member typed in the Sex/Gender column ("M", "Male",
// "f", "FEMALE", or blank) into a clean "M" / "F" / null, so a messy Excel
// column doesn't turn into a database error for the whole row.
function normalizeSex(value) {
  const v = String(value || "").trim().toUpperCase();
  if (v === "M" || v === "MALE") return "M";
  if (v === "F" || v === "FEMALE") return "F";
  return null;
}

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
  const classInfoCache = new Map();

  try {
    const workbook = XLSX.read(req.file.buffer, { type: "buffer" });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rawRows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
    const results = { added: [], skipped: [], errors: [] };

    // Pass 1: validate every row and work out which admission year it
    // belongs to (from its class's level) — but don't insert yet, so the
    // whole batch can be sorted alphabetically first.
    const toInsert = [];
    for (let i = 0; i < rawRows.length; i++) {
      const raw = rawRows[i];
      const row = {};
      for (const key of Object.keys(raw)) {
        const mapped = HEADER_MAP[normalizeHeader(key)];
        if (mapped) row[mapped] = String(raw[key]).trim();
      }

      const fullName = row.fullName;
      const className = row.class || defaultClass;
      const sex = normalizeSex(row.sex);

      if (!fullName || !className) {
        results.errors.push({ row: i + 2, reason: "Missing required field (name or class)." });
        continue;
      }

      if (!permissionCache.has(className)) {
        permissionCache.set(className, await canManageStudentsForClass(req.user, className));
      }
      if (!permissionCache.get(className)) {
        results.errors.push({ row: i + 2, reason: `You do not have permission to add students to class "${className}".` });
        continue;
      }

      if (!classInfoCache.has(className)) {
        classInfoCache.set(className, await getClassInfo(className));
      }
      const classInfo = classInfoCache.get(className);
      if (!classInfo || !classInfo.level) {
        results.errors.push({ row: i + 2, reason: `Class "${className}" has no level set yet — ask an Administrator to set its level (JHS 1/2/3) before adding students.` });
        continue;
      }

      toInsert.push({
        row: i + 2,
        fullName,
        className,
        parentPhone: row.parentPhone || null,
        parentWhatsapp: row.parentWhatsapp || null,
        sex,
        admissionYear: admissionYearFor(classInfo),
      });
    }

    // Alphabetical within each admission year — a first upload hands out
    // 001, 002, 003... in name order; a later batch just continues from
    // wherever that year's counter last left off.
    toInsert.sort((a, b) => a.admissionYear - b.admissionYear || a.fullName.localeCompare(b.fullName));

    // Pass 2: actually create the students, in that sorted order.
    for (const item of toInsert) {
      const admissionNo = await nextStudentNumber(item.admissionYear);
      try {
        await pool.query(
          `INSERT INTO students (full_name, class, admission_no, admission_year, parent_phone, parent_whatsapp, sex, approval_status, added_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8)`,
          [item.fullName, item.className, admissionNo, item.admissionYear, item.parentPhone, item.parentWhatsapp, item.sex, req.user.id]
        );
        results.added.push(admissionNo);
      } catch (e) {
        if (e.code === "23505") { // unique_violation on admission_no — shouldn't happen with generated numbers
          results.skipped.push({ row: item.row, admissionNo, reason: "Student number already exists (unexpected — please let Nana know)." });
        } else {
          results.errors.push({ row: item.row, reason: e.message });
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
