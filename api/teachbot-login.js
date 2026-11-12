// DigiSmart ERP — One login from TeachBot (Nov 2026)
// A school that has BOTH TeachBot and ERP: the principal presses "School Office (ERP)" in TeachBot,
// TeachBot's server gives a short pass, and this door turns it into a normal ERP owner session —
// exactly what api/owner-login.js gives after a correct password. ERP's own login is unchanged.
//
// The pass is proved with the shared secret TEACHBOT_LINK_KEY (the SAME value in BOTH projects,
// already used by teachbot-homework.js). It names only the ERP school and lasts 2 minutes.
// Each pass works once (its number is remembered here for its 2 minutes).
//
// POST { pass }  → 200 { ok, session_token, school:{school_id, school_code, name, email} }
//                 401 bad/old pass · 403 suspended / demo over · 404 school not found

const crypto = require('crypto');

const SUPABASE_URL = 'https://nkfxrbumhjztmdyepygt.supabase.co';

function getServiceKey() {
  return process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
}
// Same session token as owner-login.js (12 hours)
function makeSessionToken(schoolId, role, modules) {
  const payload = JSON.stringify({ sid: schoolId, role: role, mods: modules || [], exp: Date.now() + 12 * 60 * 60 * 1000 });
  const sig = crypto.createHmac('sha256', getServiceKey()).update(payload).digest('hex');
  return Buffer.from(payload).toString('base64') + '.' + sig;
}
async function sb(method, path, bodyObj) {
  const key = getServiceKey();
  const opts = { method, headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' } };
  if (bodyObj) opts.body = JSON.stringify(bodyObj);
  const r = await fetch(SUPABASE_URL + '/rest/v1/' + path, opts);
  if (!r.ok && method === 'GET') throw new Error('Database error (' + r.status + ')');
  const text = await r.text();
  try { return text ? JSON.parse(text) : null; } catch (e) { return null; }
}
function same(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
const used = new Map();   // pass number → expiry (this server copy only; the 2-minute limit covers the rest)

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  const key = process.env.TEACHBOT_LINK_KEY || '';
  if (!key || !getServiceKey()) return res.status(500).json({ ok: false, error: 'One login is not set up on the ERP server yet.' });
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const pass = String(body.pass || '');
    const dot = pass.indexOf('.');
    if (dot < 1) return res.status(401).json({ ok: false, error: 'This link is not complete. Please press School Office (ERP) in TeachBot again.' });
    const payload = pass.slice(0, dot), sig = pass.slice(dot + 1);
    const want = crypto.createHmac('sha256', key).update('tb-login.' + payload).digest('base64url');
    if (!same(sig, want)) return res.status(401).json({ ok: false, error: 'This link is not valid. Please press School Office (ERP) in TeachBot again.' });
    let p; try { p = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch (e) { p = null; }
    const now = Date.now();
    if (!p || !p.erp || !p.exp || p.exp < now || p.exp > now + 5 * 60000) {
      return res.status(401).json({ ok: false, error: 'This link has expired. Please press School Office (ERP) in TeachBot again.' });
    }
    for (const [n, e] of used) if (e < now) used.delete(n);
    if (used.has(p.n)) return res.status(401).json({ ok: false, error: 'This link was already used. Please press School Office (ERP) in TeachBot again.' });
    used.set(p.n, p.exp);

    const id = String(p.erp);
    let rows = await sb('GET', 'schools?school_id=eq.' + encodeURIComponent(id) + '&select=school_id,school_code,name,email,subscription_status,status,demo_expires&limit=1');
    if (!rows || !rows.length) rows = await sb('GET', 'schools?school_code=eq.' + encodeURIComponent(id) + '&select=school_id,school_code,name,email,subscription_status,status,demo_expires&limit=1');
    if (!rows || !rows.length) return res.status(404).json({ ok: false, error: 'This school was not found in ERP. Please contact DigiSmart support.' });
    const school = rows[0];

    // same checks as the owner login
    const st = school.subscription_status || school.status;
    if (st === 'suspended') return res.status(403).json({ ok: false, error: 'Your school account is suspended. Please contact DigiSmart ERP support.' });
    if (st === 'demo' && school.demo_expires && school.demo_expires < new Date().toISOString().split('T')[0]) {
      return res.status(403).json({ ok: false, error: 'Your demo period has ended. Please contact DigiSmart ERP to purchase a plan.' });
    }
    return res.status(200).json({
      ok: true,
      session_token: makeSessionToken(school.school_id, 'owner', ['*']),
      school: { school_id: school.school_id, school_code: school.school_code, name: school.name, email: school.email }
    });
  } catch (err) {
    console.error('teachbot-login error:', err);
    return res.status(500).json({ ok: false, error: 'Could not open ERP. Please try again in a moment.' });
  }
};
