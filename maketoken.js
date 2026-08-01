const crypto = require('crypto');

const userId = 'e890e0b9-869c-416c-b1cd-c8d12361668c';
const jwtSecret = 'MYschool2026aduanaModeljHSkey123fffmmmm';

const header = { alg: 'HS256', typ: 'JWT' };
const payload = { id: userId, name: 'Nana', role: 'teacher' };

function base64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

const data = base64url(header) + '.' + base64url(payload);
const signature = crypto.createHmac('sha256', jwtSecret).update(data).digest('base64url');

process.stdout.write(data + '.' + signature);
