// Healthy Reddit backend: pairing, toxicity scoring, policy + PIN enforcement, Gemini coaching.
// No dependencies: run with `node server.js` (Node 18+). Serves the parent portal at http://localhost:8787/
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db, save, encrypt, decrypt, hashPassword, checkPassword, token } = require('./store');
const gemini = require('./gemini');

const PYTHON_MODEL_URL = process.env.PYTHON_MODEL_URL || 'http://127.0.0.1:8766';
async function scoreWithPython(post) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  try {
    const r = await fetch(PYTHON_MODEL_URL + '/predict', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(post), signal:ctrl.signal});
    if (!r.ok) throw new Error('Python scorer HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(timer); }
}


const PORT = +process.env.PORT || 8787;
const DAY = 864e5;
const BLOCK_DAYS = 30;
const BUCKETS = ['low', 'medium', 'high'];
const PAIR_TTL = 10 * 60e3;      // pairing codes live 10 minutes
const SESSION_TTL = 30 * DAY;
const MAX_PIN_FAILS = 5, PIN_LOCK = 5 * 60e3;

// ---------- helpers ----------
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const fail = (status, msg) => { throw new HttpError(status, msg); };
const now = () => Date.now();

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 1e6) { reject(new HttpError(413, 'Body too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(new HttpError(400, 'Invalid JSON')); } });
  });
}
const bearer = req => (req.headers.authorization || '').replace(/^Bearer\s+/i, '');

function parentAuth(req) {
  const s = db.sessions[bearer(req)];
  if (!s || s.expires < now()) fail(401, 'Please sign in again.');
  const p = db.parents[s.parentId];
  if (!p) fail(401, 'Account not found.');
  return p;
}
function deviceAuth(req) {
  const d = db.devices[bearer(req)];
  if (!d) fail(401, 'This browser is not paired with a parent account.');
  const p = db.parents[d.parentId];
  if (!p) fail(401, 'Parent account not found.');
  d.lastSeen = now(); save();
  return { d, p };
}
function noteUsername(d, username) {
  if (username && typeof username === 'string' && !d.usernames.includes(username)) {
    d.usernames.push(username.slice(0, 40)); save(); // alt accounts stay covered; parent can see them
  }
  if (username) d.currentUsername = username;
}
function activeBlocks(p) {
  const out = {};
  for (const b of BUCKETS) {
    const until = p.blocks?.[b] || 0;
    out[b] = until > now() ? { blocked: true, until, daysLeft: Math.ceil((until - now()) / DAY) } : { blocked: false };
  }
  return out;
}
function newPairingCode() {
  for (let i = 0; i < 20; i++) {
    const c = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
    if (!db.pairings[c] || db.pairings[c].expires < now()) return c;
  }
  fail(503, 'Try again.');
}
const validPin = pin => typeof pin === 'string' && /^\d{4,8}$/.test(pin);

// Authenticate review requests BEFORE returning any flagged content or coaching.
// Wrong attempts share the same lockout with the final parental decision.
function verifyReviewPin(d, p, pin) {
  if (d.lockUntil > now()) fail(429, `Too many wrong PINs. Try again in ${Math.ceil((d.lockUntil - now()) / 60e3)} min.`);
  if (!validPin(pin) || pin !== decrypt(p.pinEnc)) {
    d.pinFails = (d.pinFails || 0) + 1;
    if (d.pinFails >= MAX_PIN_FAILS) { d.pinFails = 0; d.lockUntil = now() + PIN_LOCK; }
    save(); fail(403, 'That PIN is not correct.');
  }
  d.pinFails = 0; save();
}


// Thread checks waiting on a parent decision (in memory, 1 hour).
const checks = new Map();
setInterval(() => { for (const [k, v] of checks) if (v.created < now() - 3600e3) checks.delete(k); }, 60e3).unref();
setInterval(() => { for (const c in db.pairings) if (db.pairings[c].expires < now() - DAY) delete db.pairings[c]; save(); }, 3600e3).unref();

// ---------- routes ----------
const routes = {
  // ----- parent portal -----
  'POST /api/parent/signup': async (req, b) => {
    const email = String(b.email || '').trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(email)) fail(400, 'Enter a valid email.');
    if (String(b.password || '').length < 8) fail(400, 'The password needs at least 8 characters.');
    if (!validPin(b.pin)) fail(400, 'The PIN must be 4 to 8 digits.');
    if (Object.values(db.parents).some(p => p.email === email)) fail(409, 'An account with this email already exists.');
    const id = crypto.randomUUID(), { salt, hash } = hashPassword(b.password);
    db.parents[id] = { id, email, passSalt: salt, passHash: hash, pinEnc: encrypt(b.pin), blocks: {}, created: now() };
    const t = token(); db.sessions[t] = { parentId: id, expires: now() + SESSION_TTL }; save();
    return { token: t };
  },
  'POST /api/parent/login': async (req, b) => {
    const email = String(b.email || '').trim().toLowerCase();
    const p = Object.values(db.parents).find(x => x.email === email);
    if (!p || !checkPassword(String(b.password || ''), p.passSalt, p.passHash)) fail(401, 'Email or password is not correct.');
    const t = token(); db.sessions[t] = { parentId: p.id, expires: now() + SESSION_TTL }; save();
    return { token: t };
  },
  'POST /api/parent/logout': async req => { delete db.sessions[bearer(req)]; save(); return { ok: true }; },
  'GET /api/parent/me': async req => {
    const p = parentAuth(req);
    const children = Object.values(db.devices).filter(d => d.parentId === p.id)
      .map(d => ({ id: d.id, usernames: d.usernames, currentUsername: d.currentUsername || null, pairedAt: d.pairedAt, lastSeen: d.lastSeen }));
    return { email: p.email, blocks: activeBlocks(p), blockDays: BLOCK_DAYS, children };
  },
  'GET /api/parent/pin': async req => ({ pin: decrypt(parentAuth(req).pinEnc) }),
  'POST /api/parent/pin': async (req, b) => {
    const p = parentAuth(req);
    if (!checkPassword(String(b.password || ''), p.passSalt, p.passHash)) fail(401, 'Password is not correct.');
    if (!validPin(b.pin)) fail(400, 'The PIN must be 4 to 8 digits.');
    p.pinEnc = encrypt(b.pin); save(); return { ok: true };
  },
  'POST /api/parent/pairing': async req => {
    const p = parentAuth(req), code = newPairingCode();
    db.pairings[code] = { parentId: p.id, expires: now() + PAIR_TTL, redeemed: null }; save();
    return { code, expires: db.pairings[code].expires };
  },
  'GET /api/parent/pairing/:code': async (req, b, params) => {
    const p = parentAuth(req), pr = db.pairings[params.code];
    if (!pr || pr.parentId !== p.id) fail(404, 'Code not found.');
    if (pr.redeemed) return { status: 'connected', username: pr.redeemed.username };
    return { status: pr.expires < now() ? 'expired' : 'waiting', expires: pr.expires };
  },
  'POST /api/parent/blocks/reset': async (req, b) => {
    const p = parentAuth(req);
    if (b.bucket && !BUCKETS.includes(b.bucket)) fail(400, 'Unknown level.');
    if (b.bucket) delete p.blocks[b.bucket]; else p.blocks = {};
    save(); return { blocks: activeBlocks(p) };
  },
  'POST /api/parent/children/:id/unpair': async (req, b, params) => {
    const p = parentAuth(req);
    for (const t in db.devices) if (db.devices[t].id === params.id && db.devices[t].parentId === p.id) delete db.devices[t];
    save(); return { ok: true };
  },

  // ----- child extension -----
  'POST /api/device/pair': async (req, b) => {
    const code = String(b.code || '').replace(/\D/g, ''), pr = db.pairings[code];
    if (!pr || pr.redeemed || pr.expires < now()) fail(400, 'That code is not valid or has expired. Ask your parent for a new one.');
    const installId = String(b.installId || '').slice(0, 64) || crypto.randomUUID();
    // Re-pairing the same browser install replaces its old binding.
    for (const t in db.devices) if (db.devices[t].installId === installId) delete db.devices[t];
    const t = token(), id = crypto.randomUUID(), username = b.username ? String(b.username).slice(0, 40) : null;
    db.devices[t] = { id, parentId: pr.parentId, installId, usernames: username ? [username] : [], currentUsername: username,
                      pairedAt: now(), lastSeen: now(), pinFails: 0, lockUntil: 0 };
    pr.redeemed = { deviceId: id, username: username || '(not signed in)', at: now() }; save();
    return { deviceToken: t, username };
  },
  'POST /api/device/heartbeat': async (req, b) => {
    const { d, p } = deviceAuth(req); noteUsername(d, b.username);
    return { paired: true, blocks: activeBlocks(p) };
  },
  'POST /api/thread/check': async (req, b) => {
    const { d, p } = deviceAuth(req); noteUsername(d, b.username);
    const title = String(b.title || '').slice(0, 1000), body = String(b.body || '').slice(0, 5000);
    const comments = (Array.isArray(b.comments) ? b.comments : []).slice(0, 10).map(c => String(c).slice(0, 2000));
    // Trained ML only: no keyword scoring and no silent fallback.
    // This classifier requires five early comments. If unavailable, keep the
    // child on the safety cover rather than pretending the content is safe.
    if (comments.length < 5) {
      console.warn('[ML bridge] Not enough visible comments for prediction:', comments.length);
      return { action: 'unavailable', reason: 'not-enough-comments',
               message: 'Five comments are needed for this prediction.',
               mlSource: 'not-scored' };
    }
    let prediction;
    try {
      prediction = await scoreWithPython({ title, body, comments: comments.slice(0,5),
        community_name: String(b.community_name || 'unknown'),
        date_posted: String(b.date_posted || ''),
        community_members_num: Number(b.community_members_num || 0) });
    } catch (e) {
      console.warn('[ML bridge] Trained prediction failed:', e.message);
      return { action: 'unavailable', reason: 'ml-service-error',
               message: 'Safety check unavailable. Please try again.',
               mlSource: 'ml-error' };
    }
    if (!prediction || !['safe','low','medium','high'].includes(prediction.bucket)) {
      console.warn('[ML bridge] Invalid model response:', prediction);
      return { action: 'unavailable', reason: 'invalid-ml-result',
               message: 'Safety check unavailable. Please try again.',
               mlSource: 'ml-error' };
    }
    const r = { bucket: prediction.bucket, overall: prediction.score,
                categories: ['future-toxicity-risk'], components: {} };
    const mlSource = 'trained_logistic_regression';
    console.log('[ML prediction]', { bucket: r.bucket, margin: prediction.margin,
      threshold: prediction.decision_threshold });
    const blocks = activeBlocks(p);
    let action = 'allow', checkId = null;
    if (r.bucket !== 'safe') {
      if (blocks[r.bucket].blocked) action = 'redirect';
      else {
        action = 'pause'; checkId = token();
        const ctx = { deviceId: d.id, postId: String(b.postId || ''), title, body, comments, bucket: r.bucket, categories: r.categories, created: now() };
        ctx.coaching = gemini.coachingTips(ctx); // start Gemini now so tips are ready when the parent walks over
        checks.set(checkId, ctx);
      }
    }
    return { bucket: r.bucket, action, checkId, score: r.overall, components: r.components, categories: r.categories,
             blockedUntil: blocks[r.bucket]?.until || null, mlSource, prediction };
  },
  'POST /api/thread/coaching': async (req, b) => {
    const { d, p } = deviceAuth(req), c = checks.get(b.checkId);
    if (!c || c.deviceId !== d.id) fail(404, 'This review has expired. Reload the post.');
    verifyReviewPin(d, p, b.pin);
    const { tips, source } = await c.coaching;
    return { title: c.title, body: c.body, comments: c.comments,
             bucket: c.bucket, categories: c.categories, tips, source };
  },
  'POST /api/thread/decision': async (req, b) => {
    const { d, p } = deviceAuth(req), c = checks.get(b.checkId);
    if (!c || c.deviceId !== d.id) fail(404, 'This review has expired. Reload the post.');
    verifyReviewPin(d, p, b.pin);
    checks.delete(b.checkId);
    if (b.decision === 'block') {
      p.blocks[c.bucket] = now() + BLOCK_DAYS * DAY; save();
      return { action: 'redirect', bucket: c.bucket, blockedUntil: p.blocks[c.bucket] };
    }
    if (b.decision === 'view') { save(); return { action: 'unlock' }; }
    fail(400, 'Unknown decision.');
  },
  'GET /api/health': async () => ({ ok: true, model: 'trained-logistic-regression-only',
                                   gemini: gemini.hasKey() ? gemini.MODEL : 'fallback-tips', pythonModelEndpoint: PYTHON_MODEL_URL })
};

const compiled = Object.entries(routes).map(([k, fn]) => {
  const [method, pattern] = k.split(' ');
  const names = [], re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, n) => { names.push(n); return '([^/]+)'; }) + '$');
  return { method, re, names, fn };
});

// ---------- static portal ----------
const PUBLIC = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
function serveStatic(req, res, pathname) {
  const file = path.normalize(path.join(PUBLIC, pathname === '/' ? 'index.html' : pathname));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' }).end(data);
  });
}

http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*'); // the extension calls from chrome-extension://
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
  const { pathname } = new URL(req.url, 'http://x');
  if (!pathname.startsWith('/api/')) return serveStatic(req, res, pathname);
  for (const r of compiled) {
    const m = r.method === req.method && pathname.match(r.re);
    if (!m) continue;
    try {
      const body = req.method === 'POST' ? await readBody(req) : {};
      const params = Object.fromEntries(r.names.map((n, i) => [n, decodeURIComponent(m[i + 1])]));
      const out = await r.fn(req, body, params);
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(out));
    } catch (e) {
      const status = e.status || 500;
      if (status === 500) console.error(e);
      res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: status === 500 ? 'Server error' : e.message }));
    }
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'Not found' }));
}).listen(PORT, () => {
  console.log(`Healthy Reddit backend on http://localhost:${PORT}`);
  console.log(`  classifier: Python trained Logistic Regression ONLY  |  coaching: ${gemini.hasKey() ? gemini.MODEL : 'built-in tips (set GEMINI_API_KEY)'}`);
});
