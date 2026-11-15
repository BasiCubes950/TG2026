// Tiny JSON-file database. Fine for a prototype/demo; swap for a real DB before real use.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE = process.env.DB_FILE || path.join(__dirname, 'data.json');
let db;
try { db = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { db = {}; }
db.parents ??= {};   // parentId -> { id, email, passHash, passSalt, pinEnc, blocks: {low,medium,high: untilMs} }
db.sessions ??= {};  // parent session token -> { parentId, expires }
db.pairings ??= {};  // 6-digit code -> { parentId, expires, redeemed: { deviceId, username, at } | null }
db.devices ??= {};   // device token -> { id, parentId, installId, usernames: [], pairedAt, lastSeen }
db.secret ??= crypto.randomBytes(32).toString('hex'); // used to encrypt PINs at rest

let timer = null;
function save() {
  clearTimeout(timer);
  timer = setTimeout(() => fs.writeFile(FILE, JSON.stringify(db, null, 2), () => {}), 50);
}

// PINs are encrypted (not hashed) because the spec lets the parent reveal their PIN in the portal.
const key = () => crypto.createHash('sha256').update(process.env.PIN_SECRET || db.secret).digest();
function encrypt(text) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map(b => b.toString('base64')).join('.');
}
function decrypt(blob) {
  const [iv, tag, enc] = blob.split('.').map(s => Buffer.from(s, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', key(), iv); d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}

function hashPassword(pw, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(pw, salt, 64).toString('hex') };
}
function checkPassword(pw, salt, hash) {
  const h = crypto.scryptSync(pw, salt, 64);
  return crypto.timingSafeEqual(h, Buffer.from(hash, 'hex'));
}
const token = () => crypto.randomBytes(32).toString('base64url');

module.exports = { db, save, encrypt, decrypt, hashPassword, checkPassword, token };
