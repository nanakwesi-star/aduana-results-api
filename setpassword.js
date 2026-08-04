// Usage: node setpassword.js "the-password-you-want"
// Prints a bcrypt hash. Paste that hash into Neon with:
//   UPDATE users SET password_hash = 'PASTE_HASH_HERE' WHERE email = 'the-persons-email';
const bcrypt = require("bcryptjs");

const password = process.argv[2];
if (!password) {
  console.log("Usage: node setpassword.js \"your-password\"");
  process.exit(1);
}

bcrypt.hash(password, 10).then((hash) => {
  process.stdout.write(hash);
});