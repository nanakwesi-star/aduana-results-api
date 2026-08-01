require("dotenv").config();
const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");

const { router: examRoutes } = require("./routes/exams");
const { router: superAdminRoutes } = require("./routes/superAdmin");
const { router: verifyRoutes } = require("./routes/verify");
const { startLockScheduler } = require("./services/lockScheduler");

const app = express();
app.use(helmet());
app.use(express.json());
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 300 }));

// Unauthenticated, cheap to call — used by an external uptime pinger on
// free hosting tiers that spin the service down after inactivity.
app.get("/health", (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.use("/api/exams", examRoutes);
app.use("/api/super-admin", superAdminRoutes);
app.use("/verify", verifyRoutes); // public, no auth — QR code target

// Central error handler — every route above throws { status, message } on failure.
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status === 500) console.error(err);
  res.status(status).json({ error: err.message || "Something went wrong." });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Aduana Model JHS results API listening on :${PORT}`);
  startLockScheduler();
});
