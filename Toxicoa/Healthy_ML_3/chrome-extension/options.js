const $ = id => document.getElementById(id);
chrome.storage.local.get('apiBase').then(s => { $('api').value = s.apiBase || HR_DEFAULT_API; });
$('save').onclick = async () => {
  const v = $('api').value.trim().replace(/\/+$/, '') || HR_DEFAULT_API;
  await chrome.runtime.sendMessage({ type: 'setApiBase', apiBase: v });
  $('msg').textContent = 'Saved.';
};
$('test').oninput = async e => {
  const s = await TG.score(e.target.value);
  $('out').textContent = s.toFixed(2); $('lvl').textContent = TG.bucket(s);
};
