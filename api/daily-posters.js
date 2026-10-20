// DigiSmart ERP — Daily Posters API (part of Social Media Posts)
// Weekly "message" posters like the ones schools buy from social media agencies:
// teacher stories, school memories, parenting tips, exam tips, values, admission open —
// with the correspondent / principal in the picture, the school logo and name, and
// Tamil / English text laid on top cleanly in the browser (the AI never writes Tamil letters).
//
// Step 1 (this file now): the school's Daily Posters settings.
//   settings_get  {}            → { ok, settings }
//   settings_save { settings }  → { ok, settings }
// Settings are a small file in the 'social-posts' bucket: <school>/daily/settings.json
// (no new database table needed). The correspondent's photo is the SAME photo saved in
// Festival Wishes (/api/festival-wishes person / person_get), so the school saves it once.
//
// Same rules as Social Media Posts: has_social must be on, and only the owner / full-access
// staff (principal, admin) may use it.
// Env: SUPABASE_SERVICE_KEY (already set)

const crypto = require('crypto');

const SUPABASE_URL = 'https://nkfxrbumhjztmdyepygt.supabase.co';
const BUCKET = 'social-posts';

// What a school can choose. Anything else falls back to the default.
const CHOICES = {
  style: ['painted', 'placed'],       // painted = AI paints the person into the scene · placed = real photo on a shared background
  language: ['both', 'ta', 'en'],     // both = Tamil + one English line
  gender: ['sir', 'madam'],           // who is in the saved photo (so the AI draws the right person)
  per_week: [3]                       // fixed at 3 for now (decided Oct 2026)
};
const DEFAULTS = { enabled: false, style: 'placed', language: 'both', gender: 'sir', per_week: 3, from_line: '' };

function getServiceKey() {
  return process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
}
function verifySessionToken(token) {
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
// Same as Social Media Posts: 'full' = owner / principal / admin
function accessLevel(session) {
  if (!session || session.role === 'parent') return null;
  if (session.role !== 'staff') return 'full';
  const mods = Array.isArray(session.mods) ? session.mods : [];
  for (const m of mods) {
    const p = String(m).split(':');
    if (p[0] === 'social') return p[1] === 'upload' ? 'upload' : 'full';
  }
  return null;
}
async function sb(method, path) {
  const key = getServiceKey();
  const r = await fetch(SUPABASE_URL + '/rest/v1/' + path, {
    method, headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }
  });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
  if (!r.ok) throw new Error((data && data.message) || ('Database error ' + r.status));
  return data;
}
async function storeFile(buf, path, type) {
  const key = getServiceKey();
  const r = await fetch(SUPABASE_URL + '/storage/v1/object/' + BUCKET + '/' + path, {
    method: 'POST',
    headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': type, 'x-upsert': 'true', 'Cache-Control': 'max-age=60' },
    body: buf
  });
  const raw = await r.text();
  if (!r.ok && /bucket not found/i.test(raw)) throw new Error('The "social-posts" photo folder is missing in Supabase Storage. Please create it (public).');
  if (!r.ok) throw new Error('Could not save the settings: ' + raw.slice(0, 200));
}
function publicUrl(path) { return SUPABASE_URL + '/storage/v1/object/public/' + BUCKET + '/' + path; }
function str(v, max) { return String(v == null ? '' : v).trim().slice(0, max); }
function isSchool(v) { return /^[a-zA-Z0-9_-]{2,64}$/.test(String(v || '')); }
function settingsPath(sid) { return sid + '/daily/settings.json'; }

// Keep only known choices, so nothing odd is ever saved
function clean(s) {
  s = s || {};
  const out = Object.assign({}, DEFAULTS);
  out.enabled = s.enabled === true;
  for (const k of ['style', 'language', 'gender']) if (CHOICES[k].indexOf(s[k]) !== -1) out[k] = s[k];
  out.from_line = str(s.from_line, 70);
  return out;
}
async function readSettings(sid) {
  try {
    const r = await fetch(publicUrl(settingsPath(sid)) + '?t=' + Date.now());
    if (!r.ok) return Object.assign({}, DEFAULTS);
    return clean(await r.json());
  } catch (e) { return Object.assign({}, DEFAULTS); }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  if (!getServiceKey()) return res.status(500).json({ ok: false, error: 'Server key not configured.' });

  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); }
  catch (e) { return res.status(400).json({ ok: false, error: 'Invalid request.' }); }
  const action = String(body.action || '');

  try {
    const session = verifySessionToken(body.token);
    if (!session) return res.status(401).json({ ok: false, error: 'Session expired. Please log in again.' });
    if (accessLevel(session) !== 'full') return res.status(403).json({ ok: false, error: 'Only the principal / admin can use Daily Posters.' });
    const sid = String(session.sid || '');
    if (!isSchool(sid)) return res.status(401).json({ ok: false, error: 'Invalid session. Please log in again.' });

    const sch = ((await sb('GET', 'schools?school_id=eq.' + encodeURIComponent(sid) + '&select=school_id,has_social&limit=1')) || [])[0];
    if (!sch || sch.has_social !== true) {
      return res.status(403).json({ ok: false, error: 'Social Media Posts is not switched on for this school. Please contact DigiSmart.' });
    }

    if (action === 'settings_get') {
      return res.status(200).json({ ok: true, settings: await readSettings(sid) });
    }
    if (action === 'settings_save') {
      const s = clean(body.settings);
      await storeFile(Buffer.from(JSON.stringify(s)), settingsPath(sid), 'application/json');
      return res.status(200).json({ ok: true, settings: s });
    }
    return res.status(400).json({ ok: false, error: 'Unknown action.' });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || 'Server error.' });
  }
};
