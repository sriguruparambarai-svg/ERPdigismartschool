// DigiSmart ERP — Secure School Data API (Database Lockdown, Group 1: Students + Group 2: Staff)
// The ONLY door to these tables once their "Allow all" rules are removed.
// Same method as api/fee-data.js:
//   • verifies the signed session token issued at login (owner or staff)
//   • FORCES every read and write to the token's own school
//   • any logged-in staff of the school may READ these tables (fee, transport,
//     exam, attendance… pages all need the student list)
//   • CHANGING a table needs the owner, or the module that owns it (below)
//   • never sends passwords or PINs back to a browser
//
// POST { token, req: { table, action, select, filters, order, values, single, limit, orFilter, count, head } }
// POST { token, special: 'pin_status' | 'generate_pins' | 'reset_pin', ... }   (parent PINs)

const crypto = require('crypto');

const SUPABASE_URL = 'https://nkfxrbumhjztmdyepygt.supabase.co';

// table -> modules allowed to CHANGE it (owner can always change everything)
const WRITE_MODULES = {
  students:             ['admission', 'student-att', 'communication'],
  student_attendance:   ['student-att'],
  exams:                ['exam'],
  exam_marks:           ['exam'],
  exam_grading:         ['exam'],
  student_transport:    ['transport'],
  certificates_issued:  ['certificates'],
  communications:       ['communication'],
  consent_responses:    ['communication'],
  hw_completions:       ['communication'],
  birthday_wishes:      ['communication'],
  // Group 2: Staff — HRM manages staff; the attendance page adds staff, saves face photos and marks attendance
  staff:                ['hrm', 'face'],
  staff_attendance:     ['face']
};
const ALLOWED_TABLES = Object.keys(WRITE_MODULES);
const ALLOWED_ACTIONS = ['select', 'insert', 'update', 'delete'];
const ALLOWED_FILTER_OPS = ['eq', 'in', 'gte', 'lte', 'like'];

// Never sent to any browser, and never changeable through this door
// (parent passwords and PINs are changed only by the parent login / PIN actions)
// (staff login passwords and QR PINs are changed only by Staff Logins / the QR attendance server)
const SECRET_COLUMNS = ['parent_password', 'parent_password_hash', 'parent_pin_hash', 'pin_fails', 'pin_lock_until',
                        'password_hash', 'password', 'qr_pin'];

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
    const a = Buffer.from(sig, 'utf8'), b = Buffer.from(String(parts[1]), 'utf8');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;   // seal broken → reject
    const d = JSON.parse(payload);
    if (d.role !== 'owner' && d.role !== 'staff') return null;               // parent passes cannot open this door
    if (Date.now() > d.exp) return null;                                     // expired → reject
    return d;                                                                // { sid, role, mods, exp }
  } catch (e) { return null; }
}

function safeName(s) { return /^[a-zA-Z0-9_]+$/.test(String(s || '')); }
function safeSelect(s) { return /^[a-zA-Z0-9_,*\s]+$/.test(String(s || '*')); }
function baseModules(mods) {
  return (Array.isArray(mods) ? mods : []).map(function (m) { return String(m).split(':')[0]; });
}
function stripSecrets(row) {
  if (!row || typeof row !== 'object') return row;
  const out = Object.assign({}, row);
  SECRET_COLUMNS.forEach(function (c) { delete out[c]; });
  return out;
}

async function sb(method, path, bodyObj, extraHeaders) {
  const key = getServiceKey();
  const opts = {
    method,
    headers: Object.assign({
      apikey: key,
      Authorization: 'Bearer ' + key,
      'Content-Type': 'application/json',
      Prefer: 'return=representation'
    }, extraHeaders || {})
  };
  if (bodyObj) opts.body = JSON.stringify(bodyObj);
  const r = await fetch(SUPABASE_URL + '/rest/v1/' + path, opts);
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
  return { ok: r.ok, status: r.status, data: data, range: r.headers.get('content-range') || '' };
}

// ── Parent PIN ──
// A random 4-digit PIN per child, given only to parents (not written in the diary).
// Stored scrambled with the server key, so nobody can read it back — it is shown
// once, when made, for printing the slip.
function pinHash(studentId, pin) {
  return crypto.createHmac('sha256', getServiceKey()).update('parent-pin:' + studentId + ':' + String(pin)).digest('hex');
}
function newPin() { return String(crypto.randomInt(0, 10000)).padStart(4, '0'); }

async function handleSpecial(body, session, schoolId, isOwner, mods, res) {
  // PINs belong to the office: owner, or staff with Parent Communication / Admission
  if (!isOwner && mods.indexOf('communication') === -1 && mods.indexOf('admission') === -1) {
    return res.status(403).json({ ok: false, error: 'You do not have permission to manage parent PINs.' });
  }
  const sp = body.special;

  if (sp === 'pin_status') {
    const r = await sb('GET', 'students?school_id=eq.' + encodeURIComponent(schoolId) +
      '&status=eq.active&select=id,class,parent_pin_hash');
    if (!r.ok) return res.status(400).json({ ok: false, error: pinColumnHint(r.data) });
    const rows = r.data || [];
    return res.status(200).json({ ok: true, total: rows.length,
      without_pin: rows.filter(function (x) { return !x.parent_pin_hash; }).length });
  }

  if (sp === 'generate_pins') {
    // { class_name: '' = all classes, mode: 'missing' | 'all' }
    let q = 'students?school_id=eq.' + encodeURIComponent(schoolId) +
      '&status=eq.active&select=id,full_name,class,section,roll_no,admission_no,parent_pin_hash&order=class.asc,roll_no.asc';
    if (body.class_name) q += '&class=eq.' + encodeURIComponent(String(body.class_name));
    const r = await sb('GET', q);
    if (!r.ok) return res.status(400).json({ ok: false, error: pinColumnHint(r.data) });
    const todo = (r.data || []).filter(function (s) { return body.mode === 'all' || !s.parent_pin_hash; });
    const out = [];
    for (let i = 0; i < todo.length; i += 10) {
      const part = todo.slice(i, i + 10);
      const done = await Promise.all(part.map(async function (s) {
        const pin = newPin();
        const u = await sb('PATCH', 'students?id=eq.' + encodeURIComponent(s.id) + '&school_id=eq.' + encodeURIComponent(schoolId),
          { parent_pin_hash: pinHash(s.id, pin), pin_fails: 0, pin_lock_until: null });
        return u.ok ? { name: s.full_name, class: s.class, section: s.section || '', roll_no: s.roll_no || '',
                        admission_no: s.admission_no || '', pin: pin } : null;
      }));
      done.forEach(function (x) { if (x) out.push(x); });
    }
    if (todo.length && !out.length) return res.status(400).json({ ok: false, error: 'PINs could not be saved. Run the PIN setup SQL first.' });
    return res.status(200).json({ ok: true, pins: out, skipped: (r.data || []).length - todo.length });
  }

  if (sp === 'reset_pin') {
    const id = String(body.student_id || '');
    if (!id) return res.status(400).json({ ok: false, error: 'Student required.' });
    const r = await sb('GET', 'students?id=eq.' + encodeURIComponent(id) + '&school_id=eq.' + encodeURIComponent(schoolId) +
      '&select=id,full_name,class,section,roll_no,admission_no&limit=1');
    if (!r.ok || !r.data || !r.data.length) return res.status(404).json({ ok: false, error: 'Student not found.' });
    const s = r.data[0], pin = newPin();
    const u = await sb('PATCH', 'students?id=eq.' + encodeURIComponent(id) + '&school_id=eq.' + encodeURIComponent(schoolId),
      { parent_pin_hash: pinHash(id, pin), pin_fails: 0, pin_lock_until: null });
    if (!u.ok) return res.status(400).json({ ok: false, error: pinColumnHint(u.data) });
    return res.status(200).json({ ok: true, pins: [{ name: s.full_name, class: s.class, section: s.section || '',
      roll_no: s.roll_no || '', admission_no: s.admission_no || '', pin: pin }] });
  }

  if (sp === 'reset_password') {
    // Parent forgot the password they chose: remove it, so the PIN works again.
    const id = String(body.student_id || '');
    if (!id) return res.status(400).json({ ok: false, error: 'Student required.' });
    const u = await sb('PATCH', 'students?id=eq.' + encodeURIComponent(id) + '&school_id=eq.' + encodeURIComponent(schoolId),
      { parent_password: null, parent_password_hash: null, pin_fails: 0, pin_lock_until: null });
    if (!u.ok) return res.status(400).json({ ok: false, error: 'Could not reset. Please try again.' });
    return res.status(200).json({ ok: true });
  }

  return res.status(400).json({ ok: false, error: 'Unknown request.' });
}

function pinColumnHint(data) {
  const msg = (data && (data.message || data.details)) || '';
  return /parent_pin_hash|pin_fails|pin_lock_until/.test(msg)
    ? 'The PIN columns are not in the database yet. Run the PIN setup SQL first.'
    : (msg || 'Database error.');
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
  const mods = baseModules(session.mods);
  const schoolId = String(session.sid || '');
  if (!schoolId) {
    return res.status(401).json({ ok: false, error: 'Invalid session. Please log in again.' });
  }

  try {
    if (body.special) return await handleSpecial(body, session, schoolId, isOwner, mods, res);

    // ── 2. Validate the request shape ──
    const q = body.req || {};
    if (ALLOWED_TABLES.indexOf(q.table) === -1) {
      return res.status(400).json({ ok: false, error: 'Table not allowed.' });
    }
    if (ALLOWED_ACTIONS.indexOf(q.action) === -1) {
      return res.status(400).json({ ok: false, error: 'Action not allowed.' });
    }
    if (q.action !== 'select' && !isOwner) {
      const allowed = WRITE_MODULES[q.table].some(function (m) { return mods.indexOf(m) !== -1; });
      if (!allowed) return res.status(403).json({ ok: false, error: 'You do not have permission to change this.' });
    }
    const filters = Array.isArray(q.filters) ? q.filters : [];
    for (const f of filters) {
      if (ALLOWED_FILTER_OPS.indexOf(f.op) === -1 || !safeName(f.col)) {
        return res.status(400).json({ ok: false, error: 'Filter not allowed.' });
      }
    }
    if (q.select && !safeSelect(q.select)) {
      return res.status(400).json({ ok: false, error: 'Invalid column list.' });
    }
    // Updates and deletes must target specific rows
    if ((q.action === 'update' || q.action === 'delete') && filters.filter(function (f) { return f.col !== 'school_id'; }).length === 0) {
      return res.status(400).json({ ok: false, error: 'Update/delete needs a filter.' });
    }

    // ── 3. Build the database query — school lock is FORCED by the server ──
    const params = [];
    if (q.action === 'select') params.push('select=' + encodeURIComponent(q.select || '*'));
    filters.filter(function (f) { return f.col !== 'school_id'; }).forEach(function (f) {
      if (f.op === 'in') {
        const vals = (Array.isArray(f.val) ? f.val : []).map(function (v) { return '"' + String(v).replace(/"/g, '') + '"'; }).join(',');
        params.push(encodeURIComponent(f.col) + '=in.(' + vals + ')');
      } else {
        params.push(encodeURIComponent(f.col) + '=' + f.op + '.' + encodeURIComponent(f.val === null ? 'null' : String(f.val)));
      }
    });
    params.push('school_id=eq.' + encodeURIComponent(schoolId));

    if (q.orFilter) {
      // search filter (e.g. name / roll search) — keep letters (any language), digits, . , % * - _ space
      const clean = String(q.orFilter).replace(/[()'"\\;&=?#]/g, '');
      params.push('or=(' + encodeURIComponent(clean) + ')');
    }
    (Array.isArray(q.order) ? q.order : []).forEach(function (o) {
      if (safeName(o.col)) params.push('order=' + o.col + '.' + (o.asc === false ? 'desc' : 'asc'));
    });
    let limit = null;
    if (q.single) limit = 1;
    else if (q.limit && Number.isInteger(q.limit) && q.limit > 0) limit = Math.min(q.limit, 5000);
    if (limit && q.action === 'select') params.push('limit=' + limit);   // .single() after insert/update just returns the first row

    // ── 4. Prepare values (stamp the school on writes, never let secrets be written here) ──
    let payload = null;
    if (q.action === 'insert') {
      const rows = Array.isArray(q.values) ? q.values : [q.values];
      payload = rows.map(function (r) { return Object.assign(stripSecrets(r), { school_id: schoolId }); });
    } else if (q.action === 'update') {
      payload = stripSecrets(Object.assign({}, q.values));
      delete payload.school_id;               // school can never be changed
    }

    const methodMap = { select: 'GET', insert: 'POST', update: 'PATCH', delete: 'DELETE' };
    const extra = {};
    const wantCount = q.action === 'select' && q.count === 'exact';
    if (wantCount) {
      extra.Prefer = 'count=exact';
      if (q.head) { extra['Range-Unit'] = 'items'; extra.Range = '0-0'; }
    }

    const r = await sb(methodMap[q.action], q.table + '?' + params.join('&'), payload, extra);
    if (!r.ok) {
      const msg = (r.data && (r.data.message || r.data.details)) || ('Database error ' + r.status);
      return res.status(400).json({ ok: false, error: msg });
    }

    let data = r.data;
    if (Array.isArray(data)) data = data.map(stripSecrets);
    else if (data && typeof data === 'object') data = stripSecrets(data);

    let count = null;
    if (wantCount) {
      const m = /\/(\d+)$/.exec(r.range);
      count = m ? parseInt(m[1], 10) : (Array.isArray(data) ? data.length : 0);
      if (q.head) data = null;
    }
    // .single() behaves like Supabase: one object or null
    if (q.single) data = (Array.isArray(data) && data.length > 0) ? data[0] : null;

    return res.status(200).json({ ok: true, data: data, count: count });

  } catch (err) {
    console.error('student-data error:', err);
    return res.status(500).json({ ok: false, error: 'Something went wrong. Please try again.' });
  }
};
