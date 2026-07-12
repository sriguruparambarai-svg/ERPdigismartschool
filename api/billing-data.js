// DigiSmart ERP — Secure Billing Data API (Database Lockdown Phase 3, Group 2)
// The ONLY door to the four billing/accounts tables. Verifies the signed
// session token from login, allows only owners and staff with the Billing
// module, and locks every query to the token holder's own school.
//
// POST { token, req: { table, action, select, filters, order, values, single, limit } }

const crypto = require('crypto');

const SUPABASE_URL = 'https://nkfxrbumhjztmdyepygt.supabase.co';

// Only these tables can be reached through this door
const ALLOWED_TABLES = [
  'account_categories',
  'account_transactions',
  'invoices',
  'account_budget'
];
const ALLOWED_ACTIONS = ['select', 'insert', 'update', 'delete'];
const ALLOWED_FILTER_OPS = ['eq', 'in', 'gte', 'lte'];

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
    if (sig !== parts[1]) return null;               // seal broken → reject
    const d = JSON.parse(payload);
    if (Date.now() > d.exp) return null;             // expired → reject
    return d;                                        // { sid, role, mods, exp }
  } catch (e) { return null; }
}

function safeName(s) { return /^[a-zA-Z0-9_]+$/.test(String(s || '')); }
function safeSelect(s) { return /^[a-zA-Z0-9_,*\s]+$/.test(String(s || '*')); }

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
  const hasBilling = Array.isArray(session.mods) && session.mods.indexOf('billing') !== -1;
  if (!isOwner && !hasBilling) {
    return res.status(403).json({ ok: false, error: 'You do not have permission for billing data.' });
  }
  const schoolId = String(session.sid || '');
  if (!schoolId) {
    return res.status(401).json({ ok: false, error: 'Invalid session. Please log in again.' });
  }

  // ── 2. Validate the request shape ──
  const q = body.req || {};
  if (ALLOWED_TABLES.indexOf(q.table) === -1) {
    return res.status(400).json({ ok: false, error: 'Table not allowed.' });
  }
  if (ALLOWED_ACTIONS.indexOf(q.action) === -1) {
    return res.status(400).json({ ok: false, error: 'Action not allowed.' });
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
  if ((q.action === 'update' || q.action === 'delete') && filters.length === 0) {
    return res.status(400).json({ ok: false, error: 'Update/delete needs a filter.' });
  }

  // ── 3. Build the database query — school lock is FORCED by the server ──
  const params = [];
  if (q.action === 'select') params.push('select=' + encodeURIComponent(q.select || '*'));

  // Drop any client-sent school filter, then pin to the token's school
  filters.filter(f => f.col !== 'school_id').forEach(f => {
    if (f.op === 'in') {
      const vals = (Array.isArray(f.val) ? f.val : []).map(v => '"' + String(v).replace(/"/g, '') + '"').join(',');
      params.push(encodeURIComponent(f.col) + '=in.(' + vals + ')');
    } else {
      params.push(encodeURIComponent(f.col) + '=' + f.op + '.' + encodeURIComponent(String(f.val)));
    }
  });
  params.push('school_id=eq.' + encodeURIComponent(schoolId));

  (Array.isArray(q.order) ? q.order : []).forEach(o => {
    if (safeName(o.col)) params.push('order=' + o.col + '.' + (o.asc === false ? 'desc' : 'asc'));
  });

  let limit = null;
  if (q.count && !q.limit) limit = 1;
  if (q.single) limit = 1;
  else if (q.limit && Number.isInteger(q.limit) && q.limit > 0) limit = q.limit;
  if (limit) params.push('limit=' + limit);

  const url = SUPABASE_URL + '/rest/v1/' + q.table + '?' + params.join('&');

  // ── 4. Prepare values (stamp the school on writes) ──
  let payload = null;
  if (q.action === 'insert') {
    const rows = Array.isArray(q.values) ? q.values : [q.values];
    payload = rows.map(r => Object.assign({}, r, { school_id: schoolId }));
  } else if (q.action === 'update') {
    payload = Object.assign({}, q.values);
    delete payload.school_id; // school can never be changed
  }

  const methodMap = { select: 'GET', insert: 'POST', update: 'PATCH', delete: 'DELETE' };

  try {
    const key = getServiceKey();
    const opts = {
      method: methodMap[q.action],
      headers: {
        apikey: key,
        Authorization: 'Bearer ' + key,
        'Content-Type': 'application/json',
        Prefer: 'return=representation'
      }
    };
    if (payload) opts.body = JSON.stringify(payload);

    if (q.count) opts.headers.Prefer = 'return=representation,count=exact';

    const r = await fetch(url, opts);
    const text = await r.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }

    if (!r.ok) {
      const msg = (data && (data.message || data.details)) || ('Database error ' + r.status);
      return res.status(400).json({ ok: false, error: msg });
    }

    // .single() behaves like Supabase: one object or null
    if (q.single) data = (Array.isArray(data) && data.length > 0) ? data[0] : null;

    // Row count (from the count=exact header) for counter queries
    let count = null;
    if (q.count) {
      const cr = r.headers.get('content-range') || '';
      const total = cr.split('/')[1];
      count = total && total !== '*' ? parseInt(total, 10) : null;
    }

    return res.status(200).json({ ok: true, data: data, count: count });

  } catch (err) {
    console.error('billing-data error:', err);
    return res.status(500).json({ ok: false, error: 'Something went wrong. Please try again.' });
  }
};
