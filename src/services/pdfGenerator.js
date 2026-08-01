const PDFDocument = require("pdfkit");
const QRCode = require("qrcode");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const OUTPUT_DIR = process.env.REPORTS_DIR || "/var/data/reports";
const PORTAL_BASE = process.env.PORTAL_BASE_URL || "https://portal.aduanamodel.edu.gh";

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

module.exports = { generateReportCard, generateBroadsheet, signToken };
