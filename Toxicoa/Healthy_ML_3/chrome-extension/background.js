// Service worker: the only part of the extension that talks to the backend.
// Content scripts and pages send it messages; it adds the device token and handles the review window.
importScripts('config.js', 'comment-fetch.js');
const L = chrome.storage.local, SS = chrome.storage.session;

async function state() {
  const s = await L.get(['deviceToken', 'installId', 'apiBase', 'lastUsername', 'blocks', 'lastBeat']);
  if (!s.installId) { s.installId = crypto.randomUUID(); await L.set({ installId: s.installId }); }
  s.apiBase = (s.apiBase || HR_DEFAULT_API).replace(/\/+$/, '');
  return s;
}

async function call(path, body, { auth = true } = {}) {
  const s = await state();
  if (auth && !s.deviceToken) return { unpaired: true };
  let r;
  try {
    r = await fetch(s.apiBase + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: 'Bearer ' + s.deviceToken } : {}) },
      body: JSON.stringify(body || {})
    });
  } catch (e) { return { offline: true, error: 'Cannot reach the Healthy Reddit server.' }; }
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && auth) { await L.remove('deviceToken'); updateBadge(); return { unpaired: true, error: j.error }; }
  if (!r.ok) return { error: j.error || 'Server error (' + r.status + ')', status: r.status };
  return j;
}

async function updateBadge() {
  const { deviceToken } = await L.get('deviceToken');
  await chrome.action.setBadgeText({ text: deviceToken ? '' : '!' });
  await chrome.action.setBadgeBackgroundColor({ color: '#b45309' });
  await chrome.action.setTitle({ title: deviceToken ? 'Healthy Reddit: protection on' : 'Healthy Reddit: not set up yet' });
}

async function heartbeat(force) {
  const s = await state();
  if (!s.deviceToken || (!force && s.lastBeat > Date.now() - 60e3)) return;
  await L.set({ lastBeat: Date.now() });
  const r = await call('/api/device/heartbeat', { username: s.lastUsername || null });
  if (r.blocks) await L.set({ blocks: r.blocks });
}

// Reads the Reddit account currently signed in to this Chrome profile.
async function detectUsername() {
  try {
    const r = await fetch('https://www.reddit.com/api/me.json', { credentials: 'include', cache: 'no-store' });
    const j = await r.json();
    const name = j?.data?.name || j?.name || null;
    await L.set({ lastUsername: name });
    return { username: name, source: 'reddit' };
  } catch (e) {
    const { lastUsername } = await L.get('lastUsername');
    return { username: lastUsername || null, source: 'cache' };
  }
}

// ----- co-viewing review window -----
async function reviews() { return (await SS.get('reviews')).reviews || {}; }
async function saveReviews(r) { await SS.set({ reviews: r }); }

async function openReview(checkId, tabId) {
  const all = await reviews();
  if (all[checkId]?.windowId) {
    try { await chrome.windows.update(all[checkId].windowId, { focused: true }); return { ok: true }; } catch (e) { /* closed */ }
  }
  const w = await chrome.windows.create({
    url: chrome.runtime.getURL('review.html?c=' + encodeURIComponent(checkId)),
    type: 'popup', width: 480, height: 700, focused: true
  });
  all[checkId] = { tabId, windowId: w.id, decided: false };
  await saveReviews(all);
  return { ok: true };
}

chrome.windows.onRemoved.addListener(async windowId => {
  const all = await reviews();
  for (const [checkId, r] of Object.entries(all)) {
    if (r.windowId !== windowId) continue;
    if (!r.decided) chrome.tabs.sendMessage(r.tabId, { type: 'hr-review-closed', checkId }).catch(() => {});
    delete all[checkId];
  }
  await saveReviews(all);
});

async function decide(checkId, pin, decision) {
  const res = await call('/api/thread/decision', { checkId, pin, decision });
  if (!res.action) return res;
  const all = await reviews();
  if (all[checkId]) {
    all[checkId].decided = true; await saveReviews(all);
    chrome.tabs.sendMessage(all[checkId].tabId, { type: 'hr-decision', checkId, action: res.action }).catch(() => {});
    if (res.action === 'redirect') chrome.tabs.update(all[checkId].tabId, { active: true }).catch(() => {});
  }
  if (res.bucket && res.blockedUntil) {
    const { blocks = {} } = await L.get('blocks');
    blocks[res.bucket] = { blocked: true, until: res.blockedUntil };
    await L.set({ blocks });
  }
  return res;
}

// ----- messages -----
const handlers = {
  async hello() {
    await heartbeat(false); // refreshes block status at most once a minute
    const s = await state();
    return { paired: !!s.deviceToken, blocks: s.blocks || {} };
  },
  async username({ username }) {
    const { lastUsername } = await L.get('lastUsername');
    await L.set({ lastUsername: username || null });
    if (username && username !== lastUsername) heartbeat(true);
    return { ok: true };
  },
  async earlyComments({ postId }) { return hrFetchEarlyComments(postId); },
  async check({ post }) {
    const s = await state();
    return call('/api/thread/check', { ...post, username: s.lastUsername || null });
  },
  async openReview({ checkId }, sender) { return openReview(checkId, sender.tab.id); },
  async coaching({ checkId, pin }) { return call('/api/thread/coaching', { checkId, pin }); },
  async decision({ checkId, pin, decision }) { return decide(checkId, pin, decision); },
  async setupState() {
    const s = await state(), who = await detectUsername();
    return { paired: !!s.deviceToken, username: who.username, apiBase: s.apiBase };
  },
  async pair({ code }) {
    const s = await state(), who = await detectUsername();
    const res = await call('/api/device/pair', { code, installId: s.installId, username: who.username }, { auth: false });
    if (res.deviceToken) { await L.set({ deviceToken: res.deviceToken }); await updateBadge(); heartbeat(true); }
    return res;
  },
  async setApiBase({ apiBase }) { await L.set({ apiBase }); return { ok: true }; }
};

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  const fn = handlers[msg?.type];
  if (!fn) return false;
  fn(msg, sender).then(reply, e => reply({ error: String(e?.message || e) }));
  return true; // async reply
});

chrome.runtime.onInstalled.addListener(() => { updateBadge(); chrome.alarms.create('hr-heartbeat', { periodInMinutes: 15 }); });
chrome.runtime.onStartup.addListener(() => { updateBadge(); heartbeat(true); });
chrome.alarms.onAlarm.addListener(a => { if (a.name === 'hr-heartbeat') heartbeat(true); });
