// DigiSmart ERP — Salary on autopilot (Nov 2026)
// On the LAST DAY of every month (7 PM) the ERP prepares the month's salary by itself —
// the same sum as HRM → Salary Sheet: gross − PF − ESI − other deductions − loss of pay,
// where loss-of-pay days = days absent (working days = days anyone punched in) − approved
// paid leave, and a number the office typed by hand always wins. The owner gets one alert
// in the Owner App and approves it with one tap, or sends it back with a note; the office
// fixes it in ERP and presses "Send to owner for approval" again.
//
// GET  /api/salary-run                 (Vercel cron 13:30 UTC daily = 7 PM IST; acts only on the month's last day)
// GET  /api/salary-run?key=…&school=…&month=YYYY-MM&dry=1   → test run, nothing saved or sent
// POST { token (ERP owner / HRM staff), action: 'status', month }   → this month's run (for the salary sheet)
// POST { token (ERP owner / HRM staff), action: 'send', month }     → prepare again and ask the owner
// computeSalary / getRun / decide are also used by api/owner-app.js

const crypto = require('crypto');
const { sb, enc, getServiceKey, sendToSubs, pushReady } = require('./_push');

const BASE = 'https://erp.digismartschool.com';
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function istNow() { return new Date(Date.now() + 5.5 * 3600 * 1000); }
function istTodayIso() { return istNow().toISOString().slice(0, 10); }
function monthName(m) { const [y, mo] = String(m).split('-').map(Number); return (MONTH_NAMES[mo - 1] || m) + ' ' + y; }
function inr(n) { return '₹' + Number(n || 0).toLocaleString('en-IN'); }
async function safe(p, fb) { try { return await p; } catch (e) { return fb; } }
function parseJson(v, fb) { if (v == null) return fb; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch (e) { return fb; } }
function goodMonth(m) { return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(m || '')); }

async function getAll(path) {
  let out = [];
  for (let off = 0; off < 100000; off += 1000) {
    const rows = await sb('GET', path + '&limit=1000&offset=' + off) || [];
    out = out.concat(rows);
    if (rows.length < 1000) break;
  }
  return out;
}

// ── The month's salary — same rules as pages/hrm.html (loadSalarySheet + getLopMap) ──
async function computeSalary(schoolId, month) {
  const sid = enc(schoolId);
  const [yr, mo] = month.split('-').map(Number);
  const last = new Date(Date.UTC(yr, mo, 0)).getUTCDate();
  const from = month + '-01', to = month + '-' + String(last).padStart(2, '0');

  const staff = await getAll('staff?school_id=eq.' + sid + '&status=eq.active&select=id,name,employee_id,role,department&order=name.asc');
  const ids = staff.map(s => String(s.id));
  let structs = [];
  for (let i = 0; i < ids.length; i += 80) {
    structs = structs.concat(await sb('GET', 'staff_salary_structure?staff_id=in.(' + ids.slice(i, i + 80).map(enc).join(',') + ')&select=staff_id,components,gross_salary,basic_pay') || []);
  }
  const structBy = {};
  structs.forEach(s => { structBy[String(s.staff_id)] = s; });

  const set = (await safe(sb('GET', 'hrm_settings?school_id=eq.' + sid + '&select=*&limit=1'), []) || [])[0] || {};
  const st = {
    pf: !!set.pf_enabled, esi: !!set.esi_enabled,
    pfEmpPct: set.pf_emp_pct != null ? Number(set.pf_emp_pct) : 12,
    esiEmpPct: set.esi_emp_pct != null ? Number(set.esi_emp_pct) : 0.75
  };
  const dedComps = (await safe(sb('GET', 'salary_components?school_id=eq.' + sid + '&type=eq.deduction&select=id'), []) || []).map(c => String(c.id));

  // Loss of pay
  const att = await safe(getAll('staff_attendance?school_id=eq.' + sid + '&date=gte.' + from + '&date=lte.' + to + '&select=staff_id,date,status&order=date.asc'), []);
  const days = {};
  att.forEach(r => { if (r.date) days[String(r.date).slice(0, 10)] = true; });
  const workingDays = Object.keys(days).length;
  const attended = {};
  att.forEach(r => { if (r.status === 'present' || r.status === 'late') attended[String(r.staff_id)] = (attended[String(r.staff_id)] || 0) + 1; });
  const leaves = await safe(getAll('staff_leaves?school_id=eq.' + sid + '&status=eq.approved&from_date=lte.' + to + '&to_date=gte.' + from + '&select=staff_id,from_date,to_date,leave_type&order=from_date.asc'), []);
  const paidLeave = {}, unpaidLeave = {};
  const mStart = new Date(from + 'T00:00:00Z'), mEnd = new Date(to + 'T00:00:00Z');
  leaves.forEach(l => {
    const s = new Date(Math.max(new Date(String(l.from_date).slice(0, 10) + 'T00:00:00Z'), mStart));
    const e = new Date(Math.min(new Date(String(l.to_date).slice(0, 10) + 'T00:00:00Z'), mEnd));
    if (s > e) return;
    const d = Math.round((e - s) / 86400000) + 1;
    const k = String(l.staff_id);
    if (l.leave_type === 'unpaid') unpaidLeave[k] = (unpaidLeave[k] || 0) + d; else paidLeave[k] = (paidLeave[k] || 0) + d;
  });
  const proc = await safe(sb('GET', 'salary_processed?school_id=eq.' + sid + '&month=eq.' + month + '&select=staff_id,lop_days,lop_manual,status,net_salary'), []) || [];
  const procBy = {};
  proc.forEach(p => { procBy[String(p.staff_id)] = p; });

  const rows = [], missing = [];
  staff.forEach(s => {
    const k = String(s.id), sv = structBy[k];
    if (!sv) { missing.push(s.name); return; }
    const gross = Number(sv.gross_salary) || 0, basic = Number(sv.basic_pay) || 0;
    const comps = parseJson(sv.components, {}) || {};
    const pf = st.pf ? Math.round(basic * st.pfEmpPct / 100) : 0;
    const esi = st.esi && gross <= 21000 ? Math.round(gross * st.esiEmpPct / 100) : 0;
    const other = dedComps.reduce((sum, id) => sum + (Number(comps[id]) || 0), 0);
    const p = procBy[k];
    let lop, note;
    if (p && p.lop_manual) { lop = Number(p.lop_days) || 0; note = 'typed by office'; }
    else if (workingDays > 0) {
      const absent = Math.max(0, workingDays - (attended[k] || 0));
      lop = Math.max(0, absent - (paidLeave[k] || 0));
      note = absent + ' absent' + (paidLeave[k] ? ' − ' + paidLeave[k] + ' paid leave' : '');
    } else { lop = unpaidLeave[k] || 0; note = 'from unpaid leave'; }
    const lopDed = Math.round((gross / 30) * lop);
    const net = Math.max(0, gross - pf - esi - other - lopDed);
    rows.push({ staff_id: k, name: s.name || '', role: s.role || '', gross, pf, esi, other, lop_days: lop, lop_note: note, lop_ded: lopDed, net,
      paid: !!(p && p.status === 'paid') });
  });
  const totals = {
    staff: rows.length, gross: rows.reduce((a, r) => a + r.gross, 0), net: rows.reduce((a, r) => a + r.net, 0),
    lop_staff: rows.filter(r => r.lop_days > 0).length, lop_amount: rows.reduce((a, r) => a + r.lop_ded, 0),
    working_days: workingDays, missing
  };
  return { rows, totals };
}

async function getRun(schoolId, month) {
  return (await safe(sb('GET', 'salary_runs?school_id=eq.' + enc(schoolId) + '&month=eq.' + month + '&select=*&limit=1'), []) || [])[0] || null;
}

// Prepare (or prepare again) and ask the owner
async function prepareAndAsk(schoolId, month, by) {
  const { rows, totals } = await computeSalary(schoolId, month);
  if (!rows.length) return { skipped: 'no staff with a salary structure' };
  const before = await getRun(schoolId, month);
  await sb('POST', 'salary_runs?on_conflict=school_id,month', [{
    school_id: schoolId, month, status: 'waiting', rows, totals, prepared_at: new Date().toISOString(), prepared_by: by,
    decided_at: null, decided_by: null, note: null
  }], 'return=minimal,resolution=merge-duplicates');
  const again = !!before;
  const title = '💼 ' + monthName(month) + ' salary ' + (again ? 'sent again for approval' : 'ready for approval');
  const body = totals.staff + ' staff · ' + inr(totals.net) + (totals.lop_staff ? ' · ' + totals.lop_staff + ' with loss of pay' : '') +
    (totals.missing.length ? ' · ' + totals.missing.length + ' without salary set' : '');
  const day = istTodayIso();
  await sb('POST', 'owner_alerts?on_conflict=school_id,kind,alert_date', [{
    school_id: schoolId, kind: 'salary', alert_date: day, title, body, data: { month }
  }], 'return=minimal,resolution=merge-duplicates');
  let phones = 0;
  if (pushReady()) {
    const subs = await safe(sb('GET', 'owner_push_subscriptions?school_id=eq.' + enc(schoolId) + '&select=id,endpoint,p256dh,auth'), []) || [];
    if (subs.length) {
      const out = await sendToSubs(subs, () => ({ title, body, tag: 'owner-salary-' + month,
        url: BASE + '/owner/index.html?alert=salary&month=' + month }), true);
      phones = out.sent;
    }
  }
  return { title, body, owner_phones: phones };
}

// Owner's decision from the Owner App
async function decide(schoolId, month, decision, note, by) {
  const run = await getRun(schoolId, month);
  if (!run) return { error: 'This salary was not found.' };
  if (decision === 'send_back' && !String(note || '').trim()) return { error: 'Please write what the office should change.' };
  await sb('PATCH', 'salary_runs?id=eq.' + enc(run.id), {
    status: decision === 'approve' ? 'approved' : 'sent_back',
    decided_at: new Date().toISOString(), decided_by: by || 'Owner', note: decision === 'send_back' ? String(note).trim().slice(0, 500) : null
  }, 'return=minimal');
  return { ok: true };
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

module.exports = async (req, res) => {
  if (!getServiceKey()) return res.status(500).json({ ok: false, error: 'Server key not configured.' });

  if (req.method === 'POST') {
    let body;
    try { body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); }
    catch (e) { return res.status(400).json({ ok: false, error: 'Invalid request.' }); }
    const s = verifyToken(body.token);
    if (!s || !s.sid) return res.status(401).json({ ok: false, error: 'Session expired. Please log in again.' });
    const mods = Array.isArray(s.mods) ? s.mods : [];
    if (!(s.role === 'owner' || mods.indexOf('hrm') !== -1)) return res.status(403).json({ ok: false, error: 'You do not have permission for salary data.' });
    const month = String(body.month || '');
    if (!goodMonth(month)) return res.status(400).json({ ok: false, error: 'Month missing.' });
    try {
      if (body.action === 'status') return res.status(200).json({ ok: true, run: await getRun(String(s.sid), month) });
      if (body.action === 'send') {
        const r = await prepareAndAsk(String(s.sid), month, s.name || s.email || (s.role === 'owner' ? 'Owner login' : 'Office'));
        if (r.skipped) return res.status(400).json({ ok: false, error: 'No staff has a salary structure for this month.' });
        return res.status(200).json(Object.assign({ ok: true }, r, { run: await getRun(String(s.sid), month) }));
      }
      return res.status(400).json({ ok: false, error: 'Unknown action.' });
    } catch (e) { return res.status(500).json({ ok: false, error: String(e.message || e) }); }
  }

  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'GET or POST' });
  const secret = process.env.CRON_SECRET || '';
  const q = req.query || {};
  const auth = String(req.headers.authorization || '');
  if (!secret || (auth !== 'Bearer ' + secret && String(q.key || '') !== secret)) return res.status(401).json({ ok: false, error: 'Not allowed.' });
  const dry = q.dry === '1';
  const now = istNow();
  const tomorrow = new Date(now.getTime() + 86400000);
  const lastDay = tomorrow.getUTCDate() === 1;
  const month = dry && goodMonth(q.month) ? String(q.month) : now.toISOString().slice(0, 7);
  if (!dry && !lastDay) return res.status(200).json({ ok: true, skipped: 'not the last day of the month' });
  const out = { ok: true, month, dry, schools: {} };
  try {
    const ids = q.school ? [String(q.school)]
      : Array.from(new Set((await sb('GET', 'owner_app_users?select=school_id&limit=5000') || []).map(r => String(r.school_id))));
    for (const id of ids) {
      try {
        if (dry) { out.schools[id] = await computeSalary(id, month); continue; }
        const existing = await getRun(id, month);
        if (existing) { out.schools[id] = { already: existing.status }; continue; }   // office already sent it
        out.schools[id] = await prepareAndAsk(id, month, 'auto');
      } catch (e) { out.schools[id] = { ok: false, error: String(e.message || e) }; }
    }
    return res.status(200).json(out);
  } catch (e) { return res.status(500).json({ ok: false, error: String(e.message || e) }); }
};

module.exports.computeSalary = computeSalary;
module.exports.getRun = getRun;
module.exports.decide = decide;
module.exports.monthName = monthName;
