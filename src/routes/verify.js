const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const crypto = require("crypto");

/**
 * Anyone scanning a report card's QR code hits this route. It re-derives
 * the HMAC signature server-side and looks the record up fresh in the
 * database — it never trusts anything beyond the token's identifiers, so
 * a photocopied or edited PDF cannot be made to "verify" as genuine.
 */
router.get("/:token", async (req, res) => {
  try {
    const decoded = Buffer.from(req.params.token, "base64url").toString("utf8");
    const [examId, version, studentId, sig] = decoded.split(".");
    const payload = `${examId}.${version}.${studentId}`;
    const expected = crypto.createHmac("sha256", process.env.QR_SIGNING_SECRET).update(payload).digest("hex").slice(0, 24);
    if (sig !== expected) return res.status(400).json({ valid: false, reason: "Signature mismatch." });

    const { rows } = await pool.query(
      `SELECT rc.content_hash, rc.generated_at, e.class, e.subject, e.term, e.academic_year, s.full_name,
              em.score, em.grade
       FROM report_cards rc
       JOIN exams e ON e.id = rc.exam_id
       JOIN students s ON s.id = rc.student_id
       JOIN exam_marks em ON em.exam_id = rc.exam_id AND em.version = rc.version AND em.student_id = rc.student_id
       WHERE rc.exam_id = $1 AND rc.version = $2 AND rc.student_id = $3`,
      [examId, version, studentId]
    );
    if (!rows[0]) return res.status(404).json({ valid: false, reason: "No matching official record." });

    res.json({ valid: true, record: rows[0] });
  } catch {
    res.status(400).json({ valid: false, reason: "Malformed verification token." });
  }
});

module.exports = { router };
