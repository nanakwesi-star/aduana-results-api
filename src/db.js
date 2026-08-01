const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // In production, run migrations with a privileged role, then connect the
  // app itself with a role that has been REVOKEd UPDATE/DELETE on audit_log.
});

module.exports = { pool };
