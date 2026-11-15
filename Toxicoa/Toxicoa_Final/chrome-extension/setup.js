const $ = id => document.getElementById(id);
const send = (type, data = {}) => chrome.runtime.sendMessage({ type, ...data });

function accountLine(el, username) {
  el.replaceChildren();
  if (username) {
    el.append('Reddit account detected: ');
    const b = document.createElement('strong'); b.textContent = 'u/' + username; el.append(b);
  } else {
    el.classList.add('warn');
    el.textContent = 'No Reddit account is signed in. Sign in on reddit.com first so the right account is linked. (You can still connect now.)';
  }
}

async function init() {
  const s = await send('setupState');
  $('loading').hidden = true;
  $('server').textContent = 'Server: ' + s.apiBase;
  if (s.paired) { $('paired').hidden = false; accountLine($('account2'), s.username); return; }
  $('unpaired').hidden = false; accountLine($('account'), s.username);
  $('code').focus();
}

$('code').addEventListener('input', e => {
  const digits = e.target.value.replace(/\D/g, '').slice(0, 6);
  e.target.value = digits;
  $('connect').disabled = digits.length !== 6;
  $('msg').textContent = '';
});
$('code').addEventListener('keydown', e => { if (e.key === 'Enter' && !$('connect').disabled) $('connect').click(); });
$('connect').onclick = async () => {
  $('connect').disabled = true; $('connect').textContent = 'Connecting…';
  const r = await send('pair', { code: $('code').value });
  if (r.deviceToken) { $('unpaired').hidden = true; $('paired').hidden = false; accountLine($('account2'), r.username); return; }
  $('msg').textContent = r.offline ? 'Cannot reach the Healthy Reddit server. Is it running?' : (r.error || 'Could not connect.');
  $('connect').textContent = 'Connect'; $('connect').disabled = false;
};
init();
