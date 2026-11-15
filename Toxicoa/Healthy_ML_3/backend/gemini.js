// Coaching tips for the parent, from Gemini. Falls back to built-in tips when
// GEMINI_API_KEY is not set or the call fails, so the demo never breaks.
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
const KEY = process.env.GEMINI_API_KEY || '';

const FALLBACK = {
  low: [
    'Threads like this often turn snarky when people feel strongly and stay anonymous.',
    'Ask: "What made you want to open this one?" Curiosity is a good starting point.',
    'Reading a couple of replies together can show how tone escalates online.'
  ],
  medium: [
    'Group hostility often grows when a thread splits into "us vs. them" camps.',
    'Try: "How do you think the person in the post feels reading these replies?"',
    'Whatever you decide, explain your reasoning so it feels like a choice, not a punishment.'
  ],
  high: [
    'Very hostile threads usually reward pile-ons, not real discussion.',
    'Stay calm and ask: "Has anything like this come up with your friends?"',
    'If you block this level, say why, and leave the door open to talk later.'
  ]
};

function fallback(bucket) { return (FALLBACK[bucket] || FALLBACK.medium).slice(); }

async function coachingTips({ title = '', body = '', bucket = 'medium', categories = [] }) {
  if (!KEY) return { tips: fallback(bucket), source: 'fallback' };
  const prompt = [
    'You help a parent who is about to look at a Reddit thread together with their teenager.',
    'The thread was flagged by a toxicity classifier.',
    `Toxicity level: ${bucket}.` + (categories.length ? ` Signals: ${categories.join(', ')}.` : ''),
    `Post title: """${title.slice(0, 300)}"""`,
    body ? `Post text (excerpt): """${body.slice(0, 800)}"""` : '',
    'Write exactly three short bullet points (max 30 words each), non-judgmental and calm:',
    '1) why group hostility is likely happening in this specific thread,',
    '2) and 3) gentle conversation starters the parent can use with the teen about this topic.',
    'Do not quote slurs or insults. Do not lecture. Return JSON: {"tips": ["...", "...", "..."]}'
  ].filter(Boolean).join('\n');
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': KEY },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json' }
      }),
      signal: AbortSignal.timeout(12000)
    });
    if (!r.ok) throw new Error('Gemini HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200));
    const j = await r.json();
    const text = j.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
    const tips = (JSON.parse(text).tips || []).map(String).filter(Boolean).slice(0, 3);
    if (tips.length < 3) throw new Error('Gemini returned too few tips');
    return { tips, source: 'gemini' };
  } catch (e) {
    console.warn('[gemini]', e.message);
    return { tips: fallback(bucket), source: 'fallback' };
  }
}

module.exports = { coachingTips, MODEL, hasKey: () => !!KEY };
