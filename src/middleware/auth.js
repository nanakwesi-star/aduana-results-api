const jwt = require("jsonwebtoken");

// Verifies the JWT issued at login and attaches { id, name, role } to req.user.
function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Not authenticated." });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired session." });
  }
}

// Usage: requireRole('administrator', 'headmaster')
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: "You do not have permission to perform this action." });
    }
    next();
  };
}

// Captures IP + device info on every request for the audit trail.
function captureRequestContext(req, res, next) {
  req.auditContext = {
    ip: req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress,
    device: req.headers["user-agent"] || "unknown",
  };
  next();
}

module.exports = { requireAuth, requireRole, captureRequestContext };
