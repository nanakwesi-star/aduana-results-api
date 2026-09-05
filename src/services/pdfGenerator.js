const PDFDocument = require("pdfkit");
const QRCode = require("qrcode");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const OUTPUT_DIR = process.env.REPORTS_DIR || "/var/data/reports";
const PORTAL_BASE = process.env.PORTAL_BASE_URL || "https://portal.aduanamodel.edu.gh";
const CREST_PATH = path.join(__dirname, "../assets/crest.png");

// Must stay identical to SUBJECTS in the frontend and VALID_SUBJECTS in
// admin.js — this fixed order is what the terminal report prints rows in,
// subject present or not.
const SUBJECTS = [
  "English Language",
  "Mathematics",
  "Integrated Science",
  "Computing",
  "Ghanaian Language",
  "Career Technology",
  "Creative Arts and Design",
  "Social Studies",
  "RME",
];

const VIOLET = "#2E1065";
const GOLD = "#F0A500";
const STONE = "#57534e";

fs.mkdirSync(OUTPUT_DIR, { recursive: true});

/**
 * Builds an HMAC-signed verification token so a scanned QR code can be
 * checked against the live database without exposing the raw exam/student
 * IDs, and without trusting anything embedded in the PDF itself. Because
 * verification always looks up the exam_id + version + student_id in the
 * database rather than re-reading values out of the PDF, an altered PDF
 * will simply fail verification rather than "verify" bad data.
 */
function signToken(examId, version, studentId) {
  const payload = `${examId}.${version}.${studentId}`;
  const sig = crypto.createHmac("sha256", process.env.QR_SIGNING_SECRET).update(payload).digest("hex").slice(0, 24);
  return Buffer.from(`${payload}.${sig}`).toString("base64url");
}

// Terminal report tokens are prefixed "T" so /verify/:token can tell the
// two kinds of QR code apart without changing the existing per-subject
// format or breaking any report cards already printed.
function signTerminalToken(studentId, term, academicYear) {
  const payload = `T.${studentId}.${term}.${academicYear}`;
  const sig = crypto.createHmac("sha256", process.env.QR_SIGNING_SECRET).update(payload).digest("hex").slice(0, 24);
  return Buffer.from(`${payload}.${sig}`).toString("base64url");
}

/**
 * Renders one student's report card for a specific, already-approved
 * exam version. This function only ever reads from exam_versions /
 * exam_marks for the given version — it has no code path that lets it
 * pull "current" marks for a version number that isn't the one requested,
 * which is what makes locked report cards impossible to regenerate with
 * altered marks.
 */
async function generateReportCard({ exam, student, version, marksRow, dbClient }) {
  const qrToken = signToken(exam.id, version, student.id);
  const verifyUrl = `${PORTAL_BASE}/verify/${qrToken}`;
  const qrDataUrl = await QRCode.toDataURL(verifyUrl);

  const fileName = `${exam.id}_v${version}_${student.id}.pdf`;
  const filePath = path.join(OUTPUT_DIR, fileName);

  const doc = new PDFDocument({ size: "A4", margin: 50 });
  const stream = fs.createWriteStream(filePath);
  doc.pipe(stream);

  doc.fontSize(16).text("Aduana Model JHS — Examination Report", { align: "center" });
  doc.moveDown(0.5);
  doc.fontSize(11).text(`${exam.class}  ·  ${exam.subject}  ·  ${exam.term} ${exam.academic_year}`, { align: "center" });
  doc.moveDown();
  doc.fontSize(12).text(`Student: ${student.full_name}`);
  doc.text(`Score: ${marksRow.score}   Grade: ${marksRow.grade || "-"}`);
  doc.text(`Remarks: ${marksRow.remarks || "-"}`);
  doc.moveDown();
  doc.fontSize(9).fillColor("#666").text(`Record version ${version} · Exam ID ${exam.id}`);
  doc.moveDown();
  doc.image(Buffer.from(qrDataUrl.split(",")[1], "base64"), { width: 100 });
  doc.fontSize(8).text("Scan to verify authenticity against the official record.", { width: 100 });

  doc.end();
  await new Promise((resolve, reject) => { stream.on("finish", resolve); stream.on("error", reject); });

  const fileBuffer = fs.readFileSync(filePath);
  const contentHash = crypto.createHash("sha256").update(fileBuffer).digest("hex");

  await dbClient.query(
    `INSERT INTO report_cards (exam_id, student_id, version, file_path, content_hash, qr_token)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [exam.id, student.id, version, filePath, contentHash, qrToken]
  );

  return { filePath, qrToken, verifyUrl, contentHash };
}

/**
 * Renders one student's consolidated Terminal Report — all nine subjects
 * on a single PDF, styled with the school crest and colors. Unlike
 * generateReportCard (one PDF per subject), this pulls together whatever
 * subjects are currently published for the student in this class/term/
 * year and prints a row for every one of the nine official subjects,
 * leaving a subject blank if it isn't published yet rather than failing.
 *
 * subjectRows must already be in the fixed SUBJECTS order — the route
 * calling this is responsible for building that array (one entry per
 * subject, or null for "not yet available").
 */
async function generateTerminalReport({ student, className, term, academicYear, subjectRows, aggregateTotal, subjectsIncluded, positionInClass, classSize, generatedByName, dbClient, generatedByUserId }) {
  const qrToken = signTerminalToken(student.id, term, academicYear);
  const verifyUrl = `${PORTAL_BASE}/verify/${qrToken}`;
  const qrDataUrl = await QRCode.toDataURL(verifyUrl);

  const fileName = `terminal_${student.id}_${term.replace(/\s+/g, "")}_${academicYear}.pdf`;
  const filePath = path.join(OUTPUT_DIR, fileName);

  const doc = new PDFDocument({ size: "A4", margin: 40 });
  const stream = fs.createWriteStream(filePath);
  doc.pipe(stream);

  const pageWidth = doc.page.width - 80; // usable width inside margins

  // ---- Header: crest, school name, gold rule ----
  if (fs.existsSync(CREST_PATH)) doc.image(CREST_PATH, 40, 36, { width: 56 });
  doc.fillColor(VIOLET).font("Helvetica-Bold").fontSize(18).text("ADUANA MODEL JHS", 110, 40, { width: pageWidth - 70 });
  doc.font("Helvetica").fontSize(9).fillColor(STONE).text("Wiawso - Techiman  ·  Knowledge & Integrity", 110, 62);
  doc.fillColor(VIOLET).font("Helvetica-Bold").fontSize(12).text("TERMINAL REPORT", 110, 78);

  doc.moveTo(40, 104).lineTo(40 + pageWidth, 104).lineWidth(2).strokeColor(GOLD).stroke();

  // ---- Student info block ----
  let y = 118;
  const infoLeft = [
    ["Student Name", student.full_name],
    ["Admission No.", student.admission_no],
  ];
  const infoRight = [
    ["Class", className],
    ["Term / Year", `${term}  ${academicYear}`],
  ];
  doc.font("Helvetica").fontSize(10).fillColor("#1c1917");
  infoLeft.forEach(([label, value], i) => {
    doc.font("Helvetica-Bold").text(`${label}:`, 40, y + i * 16, { continued: true }).font("Helvetica").text(`  ${value}`);
  });
  infoRight.forEach(([label, value], i) => {
    doc.font("Helvetica-Bold").text(`${label}:`, 300, y + i * 16, { continued: true }).font("Helvetica").text(`  ${value}`);
  });
  y += 42;

  // ---- Subject table ----
  const cols = [
    { key: "subject", label: "Subject", width: 150 },
    { key: "classScore", label: "Class Score (/50)", width: 80 },
    { key: "examScore", label: "Exam Score (/50)", width: 80 },
    { key: "total", label: "Total (/100)", width: 70 },
    { key: "grade", label: "Grade", width: 45 },
    { key: "remarks", label: "Remarks", width: pageWidth - 150 - 80 - 80 - 70 - 45 },
  ];

  function drawRow(rowY, values, opts = {}) {
    let x = 40;
    doc.font(opts.bold ? "Helvetica-Bold" : "Helvetica").fontSize(9).fillColor(opts.color || "#1c1917");
    cols.forEach((c) => {
      doc.text(String(values[c.key] ?? ""), x + 4, rowY + 5, { width: c.width - 8 });
      x += c.width;
    });
  }

  // Header row
  doc.rect(40, y, pageWidth, 20).fill(VIOLET);
  let hx = 40;
  doc.font("Helvetica-Bold").fontSize(8.5).fillColor("#ffffff");
  cols.forEach((c) => { doc.text(c.label, hx + 4, y + 6, { width: c.width - 8 }); hx += c.width; });
  y += 20;

  subjectRows.forEach((row, i) => {
    const rowHeight = 20;
    if (i % 2 === 1) doc.rect(40, y, pageWidth, rowHeight).fill("#f5f5f4");
    if (row) {
      drawRow(y, { subject: row.subject, classScore: row.classScore, examScore: row.examScore, total: row.total, grade: row.grade || "—", remarks: row.remarks || "—" });
    } else {
      drawRow(y, { subject: SUBJECTS[i] }, {}); // subject name only; rest blank = not yet published
      doc.font("Helvetica-Oblique").fontSize(8).fillColor("#a8a29e").text("Not yet published", 40 + 150 + 4, y + 5);
    }
    y += rowHeight;
  });

  // Aggregate row
  doc.rect(40, y, pageWidth, 22).fill(GOLD);
  doc.font("Helvetica-Bold").fontSize(9.5).fillColor(VIOLET)
    .text(`Aggregate Total (${subjectsIncluded} of ${SUBJECTS.length} subjects published)`, 44, y + 6, { width: 300 })
    .text(`${aggregateTotal ?? "—"}`, 40 + 150 + 80 + 80, y + 6, { width: 70 });
  if (positionInClass) {
    doc.text(`Position: ${positionInClass} of ${classSize}`, 40 + 150 + 80 + 80 + 70 + 45, y + 6, { width: cols[5].width - 8 });
  }
  y += 22;

  // ---- Attendance / Conduct (blank fields — not tracked in the system yet) ----
  y += 20;
  doc.font("Helvetica-Bold").fontSize(9.5).fillColor(VIOLET).text("Attendance & Conduct", 40, y);
  y += 16;
  doc.font("Helvetica").fontSize(9.5).fillColor("#1c1917");
  doc.text("Total School Days: ______     Attended: ______     Absent: ______", 40, y);
  y += 16;
  doc.text("Conduct: __________________________     Interest: __________________________", 40, y);
  y += 30;

  // ---- Remarks ----
  doc.font("Helvetica-Bold").fontSize(9.5).fillColor(VIOLET).text("Class Teacher's Remarks", 40, y);
  y += 14;
  doc.moveTo(40, y + 10).lineTo(40 + pageWidth, y + 10).lineWidth(0.5).strokeColor("#d6d3d1").stroke();
  y += 34;
  doc.font("Helvetica-Bold").fontSize(9.5).fillColor(VIOLET).text("Headmaster's Remarks", 40, y);
  y += 14;
  doc.moveTo(40, y + 10).lineTo(40 + pageWidth, y + 10).lineWidth(0.5).strokeColor("#d6d3d1").stroke();
  y += 30;
  doc.font("Helvetica").fontSize(9.5).fillColor("#1c1917").text("Next Term Begins: ______________________", 40, y);

  // ---- QR verification footer ----
  const qrY = doc.page.height - 130;
  doc.image(Buffer.from(qrDataUrl.split(",")[1], "base64"), 40, qrY, { width: 70 });
  doc.font("Helvetica").fontSize(7.5).fillColor(STONE)
    .text("Scan to verify this report against the official record.", 118, qrY + 8, { width: 260 })
    .text(`Generated by ${generatedByName} · ${new Date().toLocaleDateString()}`, 118, qrY + 22, { width: 260 });

  doc.end();
  await new Promise((resolve, reject) => { stream.on("finish", resolve); stream.on("error", reject); });

  const fileBuffer = fs.readFileSync(filePath);
  const contentHash = crypto.createHash("sha256").update(fileBuffer).digest("hex");

  await dbClient.query(
    `INSERT INTO terminal_reports (student_id, class, term, academic_year, file_path, content_hash, qr_token, aggregate_total, subjects_included, position_in_class, generated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (student_id, term, academic_year) DO UPDATE SET
       file_path = EXCLUDED.file_path, content_hash = EXCLUDED.content_hash, qr_token = EXCLUDED.qr_token,
       aggregate_total = EXCLUDED.aggregate_total, subjects_included = EXCLUDED.subjects_included,
       position_in_class = EXCLUDED.position_in_class, generated_by = EXCLUDED.generated_by, generated_at = now()
     RETURNING *`,
    [student.id, className, term, academicYear, filePath, contentHash, qrToken, aggregateTotal, subjectsIncluded, positionInClass, generatedByUserId]
  );

  return { filePath, qrToken, verifyUrl, contentHash };
}

async function generateBroadsheet({ exam, version, marksRows, dbClient }) {
  const fileName = `${exam.id}_v${version}_broadsheet.pdf`;
  const filePath = path.join(OUTPUT_DIR, fileName);

  const doc = new PDFDocument({ size: "A3", layout: "landscape", margin: 40 });
  const stream = fs.createWriteStream(filePath);
  doc.pipe(stream);

  doc.fontSize(16).text(`Broadsheet — ${exam.class} · ${exam.subject} · ${exam.term} ${exam.academic_year} (v${version})`);
  doc.moveDown();
  marksRows
    .sort((a, b) => b.score - a.score)
    .forEach((m, i) => {
      doc.fontSize(10).text(`${i + 1}. ${m.full_name} — ${m.score}`);
    });

  doc.end();
  await new Promise((resolve, reject) => { stream.on("finish", resolve); stream.on("error", reject); });

  const fileBuffer = fs.readFileSync(filePath);
  const contentHash = crypto.createHash("sha256").update(fileBuffer).digest("hex");

  await dbClient.query(
    `INSERT INTO broadsheets (exam_id, version, file_path, content_hash) VALUES ($1,$2,$3,$4)`,
    [exam.id, version, filePath, contentHash]
  );

  return { filePath, contentHash };
}

module.exports = { generateReportCard, generateBroadsheet, generateTerminalReport, signToken, signTerminalToken, SUBJECTS };
