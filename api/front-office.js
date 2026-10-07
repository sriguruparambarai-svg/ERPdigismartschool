// DigiSmart ERP — Front Office API
// The ONLY door for reading and saving the Front Office registers:
// visitors, phone calls, complaints, lost & found and student out passes.
// Verifies the signed session token from login, allows only owners and
// staff with the Front Office module, and locks every read/write to the
// token holder's own school. Uses the server-side service key.
// The front_office table has Row Level Security ON with no public access.
//
// POST { token, action: 'list', category, date?, status?, status_not?, purpose?, limit? }
//   → { ok: true, rows: [...] }
// POST { token, action: 'add', category, entry: { name, mobile, purpose, meet_whom,
//        student_name, id_proof, notes, status, date, time_in } }
//   → { ok: true, row: {...} }
// POST { token, action: 'update', id, change: 'sign_out' | 'resolve' | 'claim', time_out? }
//   → { ok: true }
// POST { token, action: 'delete', id }
//   → { ok: true }

const crypto = require('crypto');

const SUPABASE_URL = 'https://nkfxrbumhjztmdyepygt.supabase.co';
const TABLE = 'front_office';
const CATEGORIES = ['visitor', 'call', 'complaint', 'lost_found', 'outpass'];
const STATUSES = ['in', 'out', 'logged', 'pending', 'resolved', 'unclaimed', 'claimed'];

function getServiceKey() {
  return process.env.SUPABASE_SERVICE_KEY
      || process.env.SUPABASE_SERVICE_ROLE_KEY
      || '';
}

// ── Verify the signed session token issued at login ──
function verifySessionToken(token) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 2) return null;
    const payload = Buffer.from(parts[0], 'base64').toString('utf8');
    const sig = crypto.createHmac('sha256', getServiceKey()).update(payload).digest('hex');
    if (sig !== parts[1]) return null;
    const d = JSON.parse(payload);
    if (Date.now() > d.exp) return null;
    return d; // { sid, role, mods, exp }
  } catch (e) { return null; }
}

async function sb(method, path, bodyObj) {
  const key = getServiceKey();
  const opts = {
    method,
    headers: {
      apikey: key,
      Authorization: 'Bearer ' + key,
      'Content-Type': 'application/json',
      Prefer: 'return=representation'
    }
  };
  if (bodyObj) opts.body = JSON.stringify(bodyObj);
  const r = await fetch(SUPABASE_URL + '/rest/v1/' + path, opts);
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
  if (!r.ok) throw new Error((data && data.message) || ('Database error ' + r.status + ': ' + text.slice(0, 200)));
  return data;
}

function str(v, max) { return String(v == null ? '' : v).trim().slice(0, max); }
function isDate(v) { return /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')); }
function isTime(v) { return /^\d{2}:\d{2}$/.test(String(v || '')); }
function isId(v) { return /^[a-zA-Z0-9-]{1,64}$/.test(String(v || '')); }

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  if (!getServiceKey()) return res.status(500).json({ ok: false, error: 'Server key not configured.' });

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  } catch (e) {
    return res.status(400).json({ ok: false, error: 'Invalid request.' });
  }

  // ── 1. Identity check ──
  const session = verifySessionToken(body.token);
  if (!session) return res.status(401).json({ ok: false, error: 'Session expired. Please log in again.' });
  const isOwner = session.role === 'owner';
  const hasModule = Array.isArray(session.mods) && session.mods.indexOf('frontoffice') !== -1;
  if (!isOwner && !hasModule) return res.status(403).json({ ok: false, error: 'You do not have permission for the Front Office.' });
  const schoolId = String(session.sid || '');
  if (!schoolId || !/^[a-zA-Z0-9_-]+$/.test(schoolId)) {
    return res.status(401).json({ ok: false, error: 'Invalid session. Please log in again.' });
  }

  const action = String(body.action || '');
  const enc = encodeURIComponent;
  const mine = 'school_id=eq.' + enc(schoolId);

  try {
    // ── 2. Read a register ──
    if (action === 'list') {
      const category = String(body.category || '');
      if (CATEGORIES.indexOf(category) === -1) return res.status(400).json({ ok: false, error: 'Unknown register.' });
      let q = TABLE + '?' + mine + '&category=eq.' + enc(category);
      if (body.date) {
        if (!isDate(body.date)) return res.status(400).json({ ok: false, error: 'Invalid date.' });
        q += '&date=eq.' + enc(body.date);
      }
      if (body.status) {
        if (STATUSES.indexOf(body.status) === -1) return res.status(400).json({ ok: false, error: 'Invalid status.' });
        q += '&status=eq.' + enc(body.status);
      }
      if (body.status_not) {
        if (STATUSES.indexOf(body.status_not) === -1) return res.status(400).json({ ok: false, error: 'Invalid status.' });
        q += '&status=neq.' + enc(body.status_not);
      }
      if (body.purpose) q += '&purpose=eq.' + enc(str(body.purpose, 60));
      const limit = Math.min(Math.max(parseInt(body.limit, 10) || 200, 1), 500);
      q += '&select=*&order=created_at.desc&limit=' + limit;
      const rows = (await sb('GET', q)) || [];
      return res.status(200).json({ ok: true, rows });
    }

    // ── 3. Add an entry ──
    if (action === 'add') {
      const category = String(body.category || '');
      if (CATEGORIES.indexOf(category) === -1) return res.status(400).json({ ok: false, error: 'Unknown register.' });
      const e = (body.entry && typeof body.entry === 'object') ? body.entry : {};
      const name = str(e.name, 120);
      if (!name) return res.status(400).json({ ok: false, error: 'Name is missing.' });
      const status = STATUSES.indexOf(e.status) !== -1 ? e.status : null;
      const row = {
        school_id: schoolId,
        category,
        name,
        mobile: str(e.mobile, 20),
        purpose: str(e.purpose, 60),
        meet_whom: str(e.meet_whom, 120),
        student_name: str(e.student_name, 120),
        id_proof: str(e.id_proof, 40),
        notes: str(e.notes, 2000),
        status,
        date: isDate(e.date) ? e.date : new Date().toISOString().split('T')[0],
        time_in: isTime(e.time_in) ? e.time_in : null
      };
      const saved = await sb('POST', TABLE, row);
      return res.status(200).json({ ok: true, row: (saved || [])[0] || null });
    }

    // ── 4. Change status (sign out / resolve / claim) ──
    if (action === 'update') {
      if (!isId(body.id)) return res.status(400).json({ ok: false, error: 'Invalid entry.' });
      let change;
      if (body.change === 'sign_out') change = { status: 'out', time_out: isTime(body.time_out) ? body.time_out : null };
      else if (body.change === 'resolve') change = { status: 'resolved' };
      else if (body.change === 'claim') change = { status: 'claimed' };
      else return res.status(400).json({ ok: false, error: 'Unknown change.' });
      const saved = (await sb('PATCH', TABLE + '?id=eq.' + enc(body.id) + '&' + mine, change)) || [];
      if (!saved.length) return res.status(404).json({ ok: false, error: 'Entry not found.' });
      return res.status(200).json({ ok: true });
    }

    // ── 5. Delete an entry ──
    if (action === 'delete') {
      if (!isId(body.id)) return res.status(400).json({ ok: false, error: 'Invalid entry.' });
      const gone = (await sb('DELETE', TABLE + '?id=eq.' + enc(body.id) + '&' + mine)) || [];
      if (!gone.length) return res.status(404).json({ ok: false, error: 'Entry not found.' });
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ ok: false, error: 'Unknown action.' });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || 'Server error.' });
  }
};
