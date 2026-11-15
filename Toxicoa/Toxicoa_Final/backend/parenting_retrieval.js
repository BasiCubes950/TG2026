// Retrieves actual, user-provided SpecialTime/DPICS utterances for Gemini.
// No external services or network calls. This dataset is therapist-authored examples,
// primarily for younger children, not validated scripts for online safety or teens.
'use strict';
const fs = require('fs');
const path = require('path');
const FILE = process.env.PARENTING_DATA_FILE || path.join(__dirname, 'parenting_data', 'specialtime.json');
const VALID = new Set(['reflection', 'labelled_praise', 'unlabelled_praise', 'behavior_description', 'question']);
const ORDER = ['reflection', 'labelled_praise', 'question', 'behavior_description'];
let rows = [], status = 'dataset-not-installed';
try {
  const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  if (!Array.isArray(raw)) throw new Error('Expected an array');
  rows = raw.filter(x => x && typeof x.statement === 'string' && VALID.has(x.label))
    .map(x => ({ label: x.label, statement: x.statement.trim().slice(0, 200),
      child_statement: typeof x.child_statement === 'string' ? x.child_statement.trim().slice(0, 180) : '' }))
    .filter(x => x.statement.length >= 5);
  status = rows.length ? `loaded-${rows.length}-supportive-examples` : 'no-supportive-records';
} catch (e) {
  status = e.code === 'ENOENT' ? 'dataset-not-installed' : 'dataset-error';
  if (e.code !== 'ENOENT') console.warn('[SpecialTime]', e.message);
}
const stop = new Set('about after again also been could does doing each from have into just like make more much other over really same some than that their them then there these they this those through want were what when where which while with would your you youre are the and for has how its not out she was why'.split(' '));
const tokens = s => new Set((String(s).toLowerCase().match(/[a-z]{3,}/g) || []).filter(x => !stop.has(x)));
const indexed = rows.map((r,i) => ({ ...r, i, terms: tokens(r.statement + ' ' + r.child_statement) }));
// A small, balanced selection is better than 6 arbitrary examples from one class.
// If there is no overlap, draw class examples only as speech-style illustrations;
// they are NOT framed as being topically relevant to the current Reddit thread.
function retrieveSamples(context, limit = 4) {
  const query = [...tokens(String(context).slice(0, 1500))].slice(0, 50);
  const results = [];
  for (const label of ORDER) {
    let best = null, bestScore = -Infinity;
    for (const row of indexed) {
      if (row.label !== label) continue;
      let overlap = 0;
      for (const t of query) if (row.terms.has(t)) overlap++;
      const hasChildPair = label === 'reflection' && row.child_statement ? 0.75 : 0;
      // Prefer usable examples with actual content over one-word interjections.
      const length = row.statement.length;
      const quality = length >= 18 && length <= 115 ? 0.3 : 0;
      const score = overlap * 10 + hasChildPair + quality - Math.abs(length-55)/500;
      if (score > bestScore) { bestScore = score; best = {...row, match: overlap > 0}; }
    }
    if (best) results.push({label:best.label,statement:best.statement,
      ...(best.child_statement ? {child_statement:best.child_statement} : {}),
      topic_match:best.match});
    if (results.length >= Math.min(4,Math.max(0,limit))) break;
  }
  return results;
}
module.exports = { retrieveSamples, status: () => status, count: () => rows.length };
