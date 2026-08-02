const crypto = require('crypto');

const userId = 'f1b23958-a778-4959-acdd-ef7c920ac84a';
const jwtSecret = 'MYschool2026aduanaModeljHSkey123fffmmmm';

const header = { alg: 'HS256', typ: 'JWT' };
const payload = { id: userId, name: 'Kwame', role: 'headmaster' };

function base64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

const data = base64url(header) + '.' + base64url(payload);
const signature = crypto.createHmac('sha256', jwtSecret).update(data).digest('base64url');

process.stdout.write(data + '.' + signature);
