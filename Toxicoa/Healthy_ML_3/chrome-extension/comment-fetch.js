// Retrieve the earliest available public comments from Reddit's own JSON endpoint.
// Only the first five non-deleted comment bodies are returned to the ML pipeline.
// This is a best-effort fallback: Reddit can rate-limit/block JSON, and a partial
// listing does not necessarily include the absolute earliest five comments.
const HR_EARLY_COMMENTS = 5;
const HR_JSON_LIMIT = 100;
function hrFlattenCommentListing(listing) {
  const found = [];
  const walk = nodes => {
    for (const node of nodes || []) {
      if (!node || node.kind !== 't1' || !node.data) continue;
      const d = node.data;
      const body = typeof d.body === 'string' ? d.body.trim() : '';
      const created = Number(d.created_utc);
      if (body && !['[deleted]', '[removed]'].includes(body.toLowerCase()) && Number.isFinite(created)) {
        found.push({ id: String(d.id || ''), text: body.slice(0, 2000), created });
      }
      if (d.replies && typeof d.replies === 'object') walk(d.replies.data?.children);
    }
  };
  walk(listing?.[1]?.data?.children);
  const seen = new Set();
  return found.sort((a,b)=>a.created-b.created || a.id.localeCompare(b.id)).filter(c => {
    const key = c.id || `${c.created}:${c.text}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}
async function hrFetchEarlyComments(postId) {
  if (!/^[a-z0-9]{5,12}$/i.test(postId || '')) return { ok: false, error: 'Invalid post ID' };
  const url = `https://www.reddit.com/comments/${encodeURIComponent(postId)}/.json?sort=old&limit=${HR_JSON_LIMIT}&depth=10&raw_json=1`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7000);
  try {
    const response = await fetch(url, {
      method: 'GET', credentials: 'include', cache: 'no-store',
      headers: { Accept: 'application/json' }, signal: controller.signal
    });
    if (!response.ok) return { ok: false, error: `Reddit returned HTTP ${response.status}` };
    const data = await response.json();
    if (!Array.isArray(data) || !data[1]?.data?.children) return { ok: false, error: 'Unexpected Reddit response' };
    const found = hrFlattenCommentListing(data);
    return { ok: true, comments: found.slice(0,HR_EARLY_COMMENTS).map(c=>c.text),
      available: found.length, source: 'reddit-json-chronological' };
  } catch(e) { return { ok: false, error: e?.name === 'AbortError' ? 'Reddit comment request timed out' : 'Reddit comments unavailable' }; }
  finally { clearTimeout(timeout); }
}
