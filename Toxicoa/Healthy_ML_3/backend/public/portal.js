const $ = id => document.getElementById(id);
const LEVELS = [['low', 'Low'], ['medium', 'Medium'], ['high', 'High']];
let mode = 'signup', pinShown = false, pollTimer = null, me = null;

async function api(path, opts = {}) {
  const r = await fetch(path, {
    method: opts.body ? 'POST' : (opts.method || 'GET'),
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (localStorage.getItem('hr_token') || '') },
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && path !== '/api/parent/login' && !path.startsWith('/api/parent/pin')) { signOut(); }
  if (!r.ok) throw new Error(j.error || 'Something went wrong.');
  return j;
}

// ---------- auth ----------
function setMode(m) {
  mode = m;
  $('tabSignup').setAttribute('aria-selected', m === 'signup');
  $('tabLogin').setAttribute('aria-selected', m === 'login');
  $('pinField').hidden = m !== 'signup';
  $('authSubmit').textContent = m === 'signup' ? 'Create account' : 'Sign in';
  $('password').autocomplete = m === 'signup' ? 'new-password' : 'current-password';
  $('authMsg').textContent = '';
}
$('tabSignup').onclick = () => setMode('signup');
$('tabLogin').onclick = () => setMode('login');
$('authForm').onsubmit = async e => {
  e.preventDefault();
  const body = { email: $('email').value, password: $('password').value };
  if (mode === 'signup') {
    body.pin = $('newPin').value;
    if (!/^\d{4,8}$/.test(body.pin)) { $('authMsg').textContent = 'The PIN must be 4 to 8 digits.'; return; }
  }
  $('authSubmit').disabled = true;
  try {
    const { token } = await api('/api/parent/' + mode, { body });
    localStorage.setItem('hr_token', token);
    $('password').value = ''; $('newPin').value = '';
    await load();
  } catch (err) { $('authMsg').textContent = err.message; }
  finally { $('authSubmit').disabled = false; }
};
function signOut() {
  localStorage.removeItem('hr_token'); clearInterval(pollTimer);
  $('dash').hidden = true; $('logout').hidden = true; $('auth').hidden = false; setMode('login');
}
$('logout').onclick = async () => { try { await api('/api/parent/logout', { body: {} }); } catch (e) {} signOut(); };

// ---------- dashboard ----------
async function load() {
  if (!localStorage.getItem('hr_token')) { $('auth').hidden = false; setMode('signup'); return; }
  try { me = await api('/api/parent/me'); } catch (e) { return; }
  $('auth').hidden = true; $('dash').hidden = false; $('logout').hidden = false;
  $('who').textContent = me.email;
  renderBlocks(me.blocks); renderChildren(me.children);
}

$('togglePin').onclick = async () => {
  if (pinShown) { $('pinView').textContent = '••••'; pinShown = false; }
  else {
    try { $('pinView').textContent = (await api('/api/parent/pin')).pin; pinShown = true; }
    catch (e) { $('pinView').textContent = '—'; }
  }
  $('togglePin').textContent = pinShown ? 'Hide PIN' : 'Show PIN';
  $('togglePin').setAttribute('aria-pressed', pinShown);
};
$('savePin').onclick = async () => {
  try {
    await api('/api/parent/pin', { body: { pin: $('chPin').value, password: $('chPass').value } });
    $('pinMsg').textContent = 'PIN updated.'; $('chPin').value = ''; $('chPass').value = '';
    if (pinShown) $('pinView').textContent = (await api('/api/parent/pin')).pin;
  } catch (e) { $('pinMsg').textContent = e.message; }
};

$('genCode').onclick = async () => {
  clearInterval(pollTimer); $('pairDone').hidden = true;
  try {
    const { code, expires } = await api('/api/parent/pairing', { body: {} });
    $('code').textContent = code; $('pairIdle').hidden = true; $('pairActive').hidden = false;
    const tick = async () => {
      const left = Math.max(0, Math.round((expires - Date.now()) / 1000));
      $('pairTimer').textContent = `(expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')})`;
      let s; try { s = await api('/api/parent/pairing/' + code); } catch (e) { return; }
      if (s.status === 'connected') {
        clearInterval(pollTimer); $('pairActive').hidden = true; $('pairIdle').hidden = false;
        $('genCode').textContent = 'Pair another browser';
        $('pairDone').hidden = false; $('pairDone').textContent = `✓ Connected to Reddit account u/${s.username}. Protection is on.`;
        load();
      } else if (s.status === 'expired' || left === 0) {
        clearInterval(pollTimer); $('pairActive').hidden = true; $('pairIdle').hidden = false;
        $('pairDone').hidden = false; $('pairDone').textContent = 'That code expired. Generate a new one.';
      }
    };
    tick(); pollTimer = setInterval(tick, 2000);
  } catch (e) { $('pairDone').hidden = false; $('pairDone').textContent = e.message; }
};

function renderBlocks(blocks) {
  $('tiers').replaceChildren(...LEVELS.map(([k, label]) => {
    const b = blocks[k], li = document.createElement('li'); li.className = 'tier';
    li.innerHTML = `<span class="badge ${k}">${label} toxicity</span>`;
    const p = document.createElement('p');
    if (b.blocked) {
      p.innerHTML = `<span class="state">Blocked</span> · ${b.daysLeft} day${b.daysLeft === 1 ? '' : 's'} left<br><span class="muted">until ${new Date(b.until).toLocaleDateString()}</span>`;
      const btn = document.createElement('button'); btn.className = 'btn secondary small'; btn.textContent = 'Reset';
      btn.onclick = () => reset(k);
      li.append(p, btn);
    } else {
      p.innerHTML = '<span class="state">Not blocked</span><br><span class="muted">Threads pause for your permission</span>';
      li.append(p);
    }
    return li;
  }));
  $('resetAll').hidden = !LEVELS.some(([k]) => blocks[k].blocked);
}
async function reset(bucket) {
  try {
    const { blocks } = await api('/api/parent/blocks/reset', { body: bucket ? { bucket } : {} });
    renderBlocks(blocks); $('blockMsg').textContent = bucket ? `${bucket[0].toUpperCase() + bucket.slice(1)} block reset.` : 'All blocks reset.';
  } catch (e) { $('blockMsg').textContent = e.message; }
}
$('resetAll').onclick = () => reset(null);

const ago = t => { const m = Math.round((Date.now() - t) / 60e3); return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : m < 1440 ? Math.round(m / 60) + ' h ago' : Math.round(m / 1440) + ' days ago'; };
function renderChildren(children) {
  if (!children.length) { $('children').innerHTML = '<li class="muted">No browser paired yet.</li>'; return; }
  $('children').replaceChildren(...children.map(c => {
    const li = document.createElement('li'), info = document.createElement('div');
    const names = c.usernames.length ? c.usernames.map(n => `<span class="tag">u/${escapeHtml(n)}${n === c.currentUsername ? ' · current' : ''}</span>`).join('') : '<span class="muted">No Reddit account seen yet</span>';
    info.innerHTML = `<div>${names}</div><div class="muted">Paired ${new Date(c.pairedAt).toLocaleDateString()} · last active ${ago(c.lastSeen)}</div>`;
    const btn = document.createElement('button'); btn.className = 'btn secondary small'; btn.textContent = 'Unpair';
    btn.onclick = async () => { if (confirm('Unpair this browser? Protection will stop until you pair it again.')) { await api(`/api/parent/children/${c.id}/unpair`, { body: {} }); load(); } };
    li.append(info, btn); return li;
  }));
}
const escapeHtml = s => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

load();
setInterval(() => { if (!$('dash').hidden) api('/api/parent/me').then(m => { renderBlocks(m.blocks); renderChildren(m.children); }).catch(() => {}); }, 15000);
