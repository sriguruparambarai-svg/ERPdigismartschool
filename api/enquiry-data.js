// DigiSmart ERP — Admission Enquiries API
// The ONLY door for the admission_enquiries table (Row Level Security ON,
// no public policies — only this server key can read or write it).
//
// Two kinds of callers:
//
// 1. PARENTS (no login) — the public enquiry form, enquiry.html
//    POST { action: 'school_info', school }            → { ok, name, logo, phone }
//    POST { action: 'submit', school, src, entry, website }
//         entry: { parent_name, mobile, child_name, class_wanted, area, message }
//         'website' is a hidden trap field: real parents never fill it, robots do.
//         Same mobile again within 24 hours is accepted quietly but not saved twice.
//         At most 300 form enquiries a day per school.
//
// 2. SCHOOL STAFF (signed login) — pages/enquiries.html
//    Owners, and staff with the "Admission Enquiries" (enquiry) module.
//    Every read/write is locked to the login's own school.
//    POST { token, action: 'link' }                     → { ok, school }
//    POST { token, action: 'list' }                     → { ok, rows }
//    POST { token, action: 'add', entry, force? }       → { ok, row } | { ok:false, duplicate }
//    POST { token, action: 'update', id, fields, note, by }  → { ok, row }
//    POST { token, action: 'delete', id }               → { ok }
//    POST { token, action: 'import', rows, source }     → { ok, added, dup, bad }

const crypto = require('crypto');

const SUPABASE_URL = 'https://nkfxrbumhjztmdyepygt.supabase.co';
const TABLE = 'admission_enquiries';
const STAGES = ['new', 'called', 'visited', 'applied', 'admitted', 'lost'];
const SOURCES = ['instagram', 'facebook', 'whatsapp', 'website', 'meta_ad',
                 'walk_in', 'phone', 'referral', 'other'];
const PUBLIC_DAILY_CAP = 300;
const IMPORT_MAX = 500;

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

function mayUse(session) {
  if (!session) return false;
  if (session.role === 'parent') return false;     // parent logins never allowed here
  if (session.role !== 'staff') return true;       // school owner
  const mods = Array.isArray(session.mods) ? session.mods : [];
  return mods.some(m => String(m).split(':')[0] === 'enquiry');
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
  if (!r.ok) {
    const msg = (data && data.message) || ('Database error ' + r.status + ': ' + text.slice(0, 200));
    if (/admission_enquiries/.test(msg) && /does not exist|not find|schema cache/i.test(msg)) {
      throw new Error('The enquiries table is not set up yet. Please run the enquiries SQL in Supabase once.');
    }
    throw new Error(msg);
  }
  return data;
}

function str(v, max) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max); }
function isDate(v) { return /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')); }
function isId(v) { return /^[a-zA-Z0-9-]{1,64}$/.test(String(v || '')); }
function isSchool(v) { return /^[a-zA-Z0-9_-]{2,64}$/.test(String(v || '')); }

// India time (UTC+5:30) — "today" for the school office
function todayIST() {
  return new Date(Date.now() + 330 * 60000).toISOString().split('T')[0];
}

// "+91 98765-43210", "p:+919876543210", "09876543210" → "9876543210"
function cleanMobile(v) {
  let d = String(v == null ? '' : v).replace(/\D/g, '');
  if (d.length > 10 && d.startsWith('91')) d = d.slice(2);
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  if (d.length > 10) d = d.slice(-10);
  return /^[6-9]\d{9}$/.test(d) ? d : '';
}

function cleanEntry(e) {
  e = (e && typeof e === 'object') ? e : {};
  return {
    parent_name: str(e.parent_name, 120),
    mobile: cleanMobile(e.mobile),
    child_name: str(e.child_name, 120),
    class_wanted: str(e.class_wanted, 30),
    area: str(e.area, 120),
    notes: str(e.notes != null ? e.notes : e.message, 1000)
  };
}

// Find the school a public link points to. The link may carry either the
// short school code or the stored school id, so both are tried.
async function findSchool(code) {
  if (!isSchool(code)) return null;
  const enc = encodeURIComponent;
  let rows = [];
  try {
    rows = (await sb('GET', 'schools?school_id=eq.' + enc(code) + '&select=*&limit=1')) || [];
  } catch (e) { rows = []; }
  if (!rows.length) {
    try {
      rows = (await sb('GET', 'schools?school_code=eq.' + enc(code) + '&select=*&limit=1')) || [];
    } catch (e) { rows = []; }   // column may not exist in this database — that is fine
  }
  return rows[0] || null;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  if (!getServiceKey()) return res.status(500).json({ ok: false, error: 'Server key not configured.' });

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  } catch (e) {
    return res.status(400).json({ ok: false, error: 'Invalid request.' });
  }

  const action = String(body.action || '');
  const enc = encodeURIComponent;

  try {
    // ════════ PUBLIC: parent enquiry form ════════
    if (action === 'school_info') {
      const school = await findSchool(body.school);
      if (!school) return res.status(404).json({ ok: false, error: 'School not found.' });
      let logo = '';
      try {
        const s = (await sb('GET', 'icard_settings?school_id=eq.' + enc(school.school_id) + '&select=logo_url&limit=1')) || [];
        const u = s[0] && s[0].logo_url;
        if (u && /^(https:|data:image\/)/.test(u)) logo = u;
      } catch (e) { /* no logo is fine */ }
      return res.status(200).json({ ok: true, name: school.name || '', logo, phone: str(school.phone, 20) });
    }

    if (action === 'submit') {
      // Robots fill every box; real parents never see this one
      if (str(body.website, 50)) return res.status(200).json({ ok: true });

      const school = await findSchool(body.school);
      if (!school) return res.status(404).json({ ok: false, error: 'School not found.' });
      // Always save under the school's stored id — the same id every ERP
      // login carries — even if the link used the short school code.
      const sid = school.school_id;

      const e = cleanEntry(body.entry);
      if (!e.mobile) return res.status(400).json({ ok: false, error: 'Please enter a correct 10-digit mobile number.' });
      if (!e.parent_name && !e.child_name) return res.status(400).json({ ok: false, error: 'Please enter your name.' });

      const mine = 'school_id=eq.' + enc(sid);
      const dayAgo = new Date(Date.now() - 24 * 3600 * 1000).toISOString();

      // Same parent pressing Send twice → keep only the first
      const again = (await sb('GET', TABLE + '?' + mine + '&mobile=eq.' + e.mobile
        + '&created_at=gte.' + enc(dayAgo) + '&select=id&limit=1')) || [];
      if (again.length) return res.status(200).json({ ok: true });

      // Daily safety cap on form enquiries for one school
      const today = todayIST();
      const todays = (await sb('GET', TABLE + '?' + mine + '&created_by=eq.' + enc('Parent form')
        + '&created_at=gte.' + enc(today + 'T00:00:00+05:30') + '&select=id&limit=' + PUBLIC_DAILY_CAP)) || [];
      if (todays.length >= PUBLIC_DAILY_CAP) {
        return res.status(429).json({ ok: false, error: 'Too many enquiries today. Please call the school.' });
      }

      const src = SOURCES.indexOf(String(body.src || '')) !== -1 ? String(body.src) : 'website';
      await sb('POST', TABLE, Object.assign({}, e, {
        school_id: sid, source: src, stage: 'new', next_call: today, created_by: 'Parent form',
        history: [{ at: new Date().toISOString(), by: 'Parent form', stage: 'new', note: 'Enquiry form filled' }]
      }));
      return res.status(200).json({ ok: true });
    }

    // ════════ STAFF: everything below needs a login ════════
    const session = verifySessionToken(body.token);
    if (!session) return res.status(401).json({ ok: false, error: 'Session expired. Please log in again.' });
    if (!mayUse(session)) return res.status(403).json({ ok: false, error: 'You do not have permission for Admission Enquiries.' });
    const schoolId = String(session.sid || '');
    if (!isSchool(schoolId)) return res.status(401).json({ ok: false, error: 'Invalid session. Please log in again.' });
    const mine = 'school_id=eq.' + enc(schoolId);
    const by = str(body.by, 60) || (session.role === 'staff' ? 'Staff' : 'Office');

    if (action === 'link') {
      return res.status(200).json({ ok: true, school: schoolId });
    }

    if (action === 'list') {
      const rows = (await sb('GET', TABLE + '?' + mine + '&select=*&order=created_at.desc&limit=2000')) || [];
      return res.status(200).json({ ok: true, rows });
    }

    if (action === 'add') {
      const e = cleanEntry(body.entry);
      if (!e.mobile) return res.status(400).json({ ok: false, error: 'Please enter a correct 10-digit mobile number.' });
      if (!e.parent_name && !e.child_name) return res.status(400).json({ ok: false, error: 'Please enter the parent or child name.' });
      if (!body.force) {
        const same = (await sb('GET', TABLE + '?' + mine + '&mobile=eq.' + e.mobile
          + '&select=id,parent_name,child_name,stage&limit=1')) || [];
        if (same.length) return res.status(200).json({ ok: false, duplicate: true, existing: same[0] });
      }
      const src = SOURCES.indexOf(String((body.entry || {}).source || '')) !== -1 ? String(body.entry.source) : 'walk_in';
      const next = isDate((body.entry || {}).next_call) ? body.entry.next_call : todayIST();
      const saved = await sb('POST', TABLE, Object.assign({}, e, {
        school_id: schoolId, source: src, stage: 'new', next_call: next, created_by: by,
        history: [{ at: new Date().toISOString(), by, stage: 'new', note: e.notes || 'Enquiry added' }]
      }));
      return res.status(200).json({ ok: true, row: (saved || [])[0] || null });
    }

    if (action === 'update') {
      if (!isId(body.id)) return res.status(400).json({ ok: false, error: 'Invalid enquiry.' });
      const found = (await sb('GET', TABLE + '?id=eq.' + enc(body.id) + '&' + mine + '&select=*&limit=1')) || [];
      if (!found.length) return res.status(404).json({ ok: false, error: 'Enquiry not found.' });
      const old = found[0];

      const f = (body.fields && typeof body.fields === 'object') ? body.fields : {};
      const patch = {};
      if (f.stage !== undefined) {
        if (STAGES.indexOf(f.stage) === -1) return res.status(400).json({ ok: false, error: 'Unknown stage.' });
        patch.stage = f.stage;
      }
      if (f.next_call !== undefined) {
        if (f.next_call === null || f.next_call === '') patch.next_call = null;
        else if (isDate(f.next_call)) patch.next_call = f.next_call;
        else return res.status(400).json({ ok: false, error: 'Invalid call-back date.' });
      }
      if (f.source !== undefined) {
        if (SOURCES.indexOf(f.source) === -1) return res.status(400).json({ ok: false, error: 'Unknown source.' });
        patch.source = f.source;
      }
      ['parent_name', 'child_name', 'class_wanted', 'area'].forEach(k => {
        if (f[k] !== undefined) patch[k] = str(f[k], k === 'class_wanted' ? 30 : 120);
      });
      if (f.mobile !== undefined) {
        const m = cleanMobile(f.mobile);
        if (!m) return res.status(400).json({ ok: false, error: 'Please enter a correct 10-digit mobile number.' });
        patch.mobile = m;
      }
      // Finished families need no more call-backs
      if (patch.stage === 'admitted' || patch.stage === 'lost') patch.next_call = null;

      const note = str(body.note, 1000);
      if (note || patch.stage) {
        const hist = Array.isArray(old.history) ? old.history.slice(-49) : [];
        hist.push({ at: new Date().toISOString(), by, stage: patch.stage || old.stage, note });
        patch.history = hist;
      }
      if (!Object.keys(patch).length) return res.status(400).json({ ok: false, error: 'Nothing to save.' });
      patch.updated_at = new Date().toISOString();

      const saved = (await sb('PATCH', TABLE + '?id=eq.' + enc(body.id) + '&' + mine, patch)) || [];
      return res.status(200).json({ ok: true, row: saved[0] || null });
    }

    if (action === 'delete') {
      if (!isId(body.id)) return res.status(400).json({ ok: false, error: 'Invalid enquiry.' });
      const gone = (await sb('DELETE', TABLE + '?id=eq.' + enc(body.id) + '&' + mine)) || [];
      if (!gone.length) return res.status(404).json({ ok: false, error: 'Enquiry not found.' });
      return res.status(200).json({ ok: true });
    }

    if (action === 'import') {
      const list = Array.isArray(body.rows) ? body.rows.slice(0, IMPORT_MAX) : [];
      if (!list.length) return res.status(400).json({ ok: false, error: 'No rows to import.' });
      const src = SOURCES.indexOf(String(body.source || '')) !== -1 ? String(body.source) : 'meta_ad';

      const have = (await sb('GET', TABLE + '?' + mine + '&select=mobile&limit=10000')) || [];
      const seen = new Set(have.map(r => r.mobile));
      const today = todayIST();
      const now = new Date().toISOString();
      const toAdd = [];
      let dup = 0, bad = 0;
      list.forEach(r => {
        const e = cleanEntry(r);
        if (!e.mobile || (!e.parent_name && !e.child_name)) { bad++; return; }
        if (seen.has(e.mobile)) { dup++; return; }
        seen.add(e.mobile);
        toAdd.push(Object.assign({}, e, {
          school_id: schoolId, source: src, stage: 'new', next_call: today, created_by: by,
          history: [{ at: now, by, stage: 'new', note: 'Imported from file' }]
        }));
      });
      if (toAdd.length) await sb('POST', TABLE, toAdd);
      return res.status(200).json({ ok: true, added: toAdd.length, dup, bad });
    }

    return res.status(400).json({ ok: false, error: 'Unknown action.' });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || 'Server error.' });
  }
};
