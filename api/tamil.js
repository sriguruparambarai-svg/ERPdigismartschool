// DigiSmart ERP — Tamil for notices the office types (Oct 2026)
// The office types a notice in English; this writes simple Tamil to go just
// below it. The Tamil is shown in a box so the office can read and correct
// it before pressing Send. Fixed messages (absent, homework, discipline,
// birthday, results) do not use this — their Tamil is written once in _tamil.js.
//
// POST { token (staff/admin), text } → { ok, tamil }
// Env: ANTHROPIC_API_KEY, SUPABASE_SERVICE_KEY (for the login seal)

const crypto = require('crypto');

// Strongest model first (Tamil words and their shades of meaning), then the next one
const MODELS = [process.env.TAMIL_MODEL || 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-sonnet-4-5'];

function getServiceKey() {
  return process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
}

function verifyToken(token) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 2) return null;
    const payload = Buffer.from(parts[0], 'base64').toString('utf8');
    const sig = crypto.createHmac('sha256', getServiceKey()).update(payload).digest('hex');
    if (sig !== parts[1]) return null;
    const d = JSON.parse(payload);
    if (Date.now() > d.exp) return null;
    return d;
  } catch (e) { return null; }
}

const PROMPT = `You write Tamil versions of short school messages for parents in a small Tamil Nadu town.
Many parents studied only up to school level, so the Tamil must be SIMPLE, everyday spoken-style written Tamil — the way a friendly school office would write to parents. Short sentences. No literary or rare words. Polite (use "தயவுசெய்து", "அனுப்பவும்", "வரவும்" style).
Rules:
- Keep children's names, class names (e.g. Class 5, UKG), subject names, book or lesson names, times, dates and amounts exactly as written in English letters/numbers.
- Common English words that village parents use every day may stay in English (school, bus, van, fees, ID card, PTA meeting, exam).
- Keep the same meaning — add nothing, leave nothing out.
- Keep line breaks the same.
- Reply with the Tamil text only. No English, no notes, no quotes.

Message:
`;

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); }
  catch (e) { return res.status(400).json({ ok: false, error: 'Bad request.' }); }

  const s = verifyToken(body.token);
  if (!s || !s.sid || s.role === 'parent') return res.status(401).json({ ok: false, error: 'Please log in again.' });

  const text = String(body.text || '').trim().slice(0, 2000);
  if (!text) return res.status(400).json({ ok: false, error: 'Type the English message first.' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ ok: false, error: 'AI is not set up (ANTHROPIC_API_KEY missing in Vercel).' });

  let lastErr = '';
  for (const model of MODELS) {
    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model, max_tokens: 1500, messages: [{ role: 'user', content: PROMPT + text }] })
      });
      const raw = await r.text();
      // model not available on this account → try the next one
      if (r.status === 404 || (r.status === 400 && /model/i.test(raw) && /not.?found|invalid|does not exist/i.test(raw))) { lastErr = raw; continue; }
      if (!r.ok) { lastErr = raw; continue; }
      const data = JSON.parse(raw);
      const tamil = ((data.content || []).filter(c => c.type === 'text').map(c => c.text).join('') || '').trim();
      if (!/[஀-௿]/.test(tamil)) { lastErr = 'No Tamil came back.'; continue; }
      return res.status(200).json({ ok: true, tamil });
    } catch (e) { lastErr = String(e.message || e); }
  }
  return res.status(500).json({ ok: false, error: 'Could not write the Tamil now. Please try again. (' + lastErr.slice(0, 160) + ')' });
};
