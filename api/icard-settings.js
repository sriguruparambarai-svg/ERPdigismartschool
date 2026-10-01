// DigiSmart ERP — I-Card Settings API
// The ONLY door for reading and saving a school's I-Card settings
// (school name, address, logo, principal name, colours, terms).
// The report card also reads its school logo from these settings.
// Verifies the signed session token from login, allows only owners and
// staff with the I-Card module, and locks every read/write to the token
// holder's own school. Uses the server-side service key.
//
// POST { token, action: 'get' }
//   → { ok: true, settings: {...} | null }
// POST { token, action: 'save', settings: {...} }
//   → { ok: true, settings: {...}, skipped: [field names the table doesn't have] }

const crypto = require('crypto');

const SUPABASE_URL = 'https://nkfxrbumhjztmdyepygt.supabase.co';
const TABLE = 'icard_settings';

// Only these fields may be saved. Anything else sent is ignored.
const TEXT_FIELDS = {
  name1: 120, name2: 120, address: 300, phone: 60, email: 120, website: 160,
  acyear: 20, studentColor: 20, staffColor: 20, logo_url: 400,
  principal_name: 120, terms_student: 2000, terms_staff: 2000
};
const BOOL_FIELDS = ['showBlood'];

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

// Keep only allowed fields, trimmed to safe lengths
function cleanSettings(input, schoolId) {
  const out = {};
  const s = (input && typeof input === 'object') ? input : {};
  Object.keys(TEXT_FIELDS).forEach(k => {
    if (s[k] === undefined || s[k] === null) return;
    out[k] = String(s[k]).slice(0, TEXT_FIELDS[k]);
  });
  BOOL_FIELDS.forEach(k => {
    if (s[k] === undefined || s[k] === null) return;
    out[k] = !!s[k];
  });
  // The logo must be this school's own uploaded logo (or empty)
  if (out.logo_url) {
    const allowed = SUPABASE_URL + '/storage/v1/object/public/icard-photos/' + schoolId + '/';
    if (out.logo_url.indexOf(allowed) !== 0) delete out.logo_url;
  }
  return out;
}

// Save, and if the table is missing a column, leave that field out and try again
async function saveRow(schoolId, fields) {
  const enc = encodeURIComponent;
  const skipped = [];
  let row = Object.assign({}, fields);
  for (let attempt = 0; attempt < 15; attempt++) {
    try {
      const existing = (await sb('GET', TABLE + '?school_id=eq.' + enc(schoolId) + '&select=id&limit=1')) || [];
      let saved;
      if (existing.length) {
        saved = await sb('PATCH', TABLE + '?school_id=eq.' + enc(schoolId), row);
      } else {
        saved = await sb('POST', TABLE, Object.assign({ school_id: schoolId }, row));
      }
      return { saved: (saved || [])[0] || null, skipped };
    } catch (e) {
      const msg = String(e.message || e);
      const m = msg.match(/Could not find the '([^']+)' column/);
      if (m && Object.prototype.hasOwnProperty.call(row, m[1])) {
        skipped.push(m[1]);
        delete row[m[1]];
        continue;
      }
      throw e;
    }
  }
  throw new Error('Could not save settings.');
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'POST only' });
  }
  if (!getServiceKey()) {
    return res.status(500).json({ ok: false, error: 'Server key not configured.' });
  }

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  } catch (e) {
    return res.status(400).json({ ok: false, error: 'Invalid request.' });
  }

  // ── 1. Identity check ──
  const session = verifySessionToken(body.token);
  if (!session) {
    return res.status(401).json({ ok: false, error: 'Session expired. Please log in again.' });
  }
  const isOwner = session.role === 'owner';
  const hasIcard = Array.isArray(session.mods) && session.mods.indexOf('icard') !== -1;
  if (!isOwner && !hasIcard) {
    return res.status(403).json({ ok: false, error: 'You do not have permission for I-Cards.' });
  }
  const schoolId = String(session.sid || '');
  if (!schoolId || !/^[a-zA-Z0-9_-]+$/.test(schoolId)) {
    return res.status(401).json({ ok: false, error: 'Invalid session. Please log in again.' });
  }

  const action = String(body.action || '');

  // ── 2. Read ──
  if (action === 'get') {
    try {
      const rows = (await sb('GET', TABLE + '?school_id=eq.' + encodeURIComponent(schoolId) + '&select=*&limit=1')) || [];
      return res.status(200).json({ ok: true, settings: rows[0] || null });
    } catch (e) {
      return res.status(500).json({ ok: false, error: 'Could not load I-Card settings. ' + String(e.message || e).slice(0, 200) });
    }
  }

  // ── 3. Save ──
  if (action === 'save') {
    const fields = cleanSettings(body.settings, schoolId);
    if (!Object.keys(fields).length) {
      return res.status(400).json({ ok: false, error: 'Nothing to save.' });
    }
    try {
      const out = await saveRow(schoolId, fields);
      return res.status(200).json({ ok: true, settings: out.saved, skipped: out.skipped });
    } catch (e) {
      return res.status(500).json({ ok: false, error: 'Could not save I-Card settings. ' + String(e.message || e).slice(0, 200) });
    }
  }

  return res.status(400).json({ ok: false, error: 'Unknown action.' });
};
