// DigiSmart ERP — Owner's Evening Report (Nov 2026)
// Every evening at 6 PM the ERP tells each school owner, in the Owner App, what
// happened today — without anyone opening the ERP:
//   • Fees collected today — total, receipts, cash / UPI / online, who paid
//   • Students absent 3 or more school days in a row (still absent today)
//   • New admission enquiries today
//   • New admissions today (students added to the ERP today)
// One alert per school per day (owner_alerts kind 'evening_report'); the full
// details travel inside the alert, so the Owner App opens them instantly.
// Only schools with at least one Owner App person get it. A day with nothing to
// report (holiday, Sunday) sends nothing.
//
// GET /api/evening-report                    (Vercel cron 12:30 UTC = 6 PM IST, Bearer CRON_SECRET)
// GET /api/evening-report?key=…&school=…&dry=1&date=YYYY-MM-DD   → test run, nothing saved or sent

const { sb, enc, getServiceKey, sendToSubs, pushReady } = require('./_push');

const BASE = 'https://erp.digismartschool.com';
const DAY = 86400000;
const STREAK_MIN = 3;

function istTodayIso() { return new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10); }
function addDays(iso, n) { return new Date(new Date(iso + 'T00:00:00Z').getTime() + n * DAY).toISOString().slice(0, 10); }
function inr(n) { return '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 }); }
function money(n) { return Math.round((Number(n) || 0) * 100) / 100; }
function clsText(c, s) { return String(c || '') + (s ? ' ' + s : ''); }

// Reads every row, 1000 at a time
async function getAll(path) {
  let out = [];
  for (let off = 0; off < 100000; off += 1000) {
    const rows = await sb('GET', path + '&limit=1000&offset=' + off) || [];
    out = out.concat(rows);
    if (rows.length < 1000) break;
  }
  return out;
}
async function safe(p, fallback) { try { return await p; } catch (e) { return fallback; } }

// ── 1. Fees collected today ──
async function feesToday(schoolId, day) {
  let rows = await safe(getAll('fee_payments?school_id=eq.' + enc(schoolId) + '&payment_date=eq.' + day +
    '&is_cancelled=not.is.true&select=student_id,student_name,student_class,fee_head_name,period,amount_paid,payment_mode,receipt_no&order=created_at.asc'), null);
  if (rows === null) {   // older databases without is_cancelled
    rows = await safe(getAll('fee_payments?school_id=eq.' + enc(schoolId) + '&payment_date=eq.' + day +
      '&select=student_id,student_name,student_class,fee_head_name,period,amount_paid,payment_mode,receipt_no&order=created_at.asc'), []);
  }
  const byMode = {}, byStudent = {}, receipts = new Set();
  let total = 0;
  rows.forEach(r => {
    const amt = Number(r.amount_paid) || 0;
    if (amt <= 0) return;
    total += amt;
    const mode = String(r.payment_mode || 'cash').toLowerCase();
    byMode[mode] = money((byMode[mode] || 0) + amt);
    if (r.receipt_no) receipts.add(String(r.receipt_no));
    const k = String(r.student_id || r.student_name);
    if (!byStudent[k]) byStudent[k] = { name: r.student_name || '', class: r.student_class || '', amount: 0, items: [], modes: [] };
    const s = byStudent[k];
    s.amount = money(s.amount + amt);
    const label = (r.fee_head_name || 'Fee') + (r.period ? ' · ' + r.period : '');
    if (s.items.indexOf(label) === -1) s.items.push(label);
    if (s.modes.indexOf(mode) === -1) s.modes.push(mode);
  });
  const payers = Object.keys(byStudent).map(k => byStudent[k]).sort((a, b) => b.amount - a.amount);
  return { total: money(total), receipts: receipts.size || payers.length, payers: payers.length, by_mode: byMode, list: payers };
}

// ── 2. Students absent 3+ school days in a row (and still absent today) ──
// School days = days the school marked attendance. Leave applied by the parent is shown.
async function longAbsent(schoolId, day) {
  const since = addDays(day, -45);
  const rows = await safe(getAll('student_attendance?school_id=eq.' + enc(schoolId) + '&date=gte.' + since + '&date=lte.' + day +
    '&select=student_id,student_name,class,date,status&order=date.desc'), []);
  if (!rows.some(r => String(r.date).slice(0, 10) === day)) return { taken_today: false, absent_today: 0, list: [] };
  const days = Array.from(new Set(rows.map(r => String(r.date).slice(0, 10)))).sort().reverse();   // newest first
  const byStu = {};
  rows.forEach(r => {
    const k = String(r.student_id);
    if (!byStu[k]) byStu[k] = { name: r.student_name || '', class: r.class || '', marks: {} };
    byStu[k].marks[String(r.date).slice(0, 10)] = r.status;
  });
  let absentToday = 0;
  const list = [];
  Object.keys(byStu).forEach(id => {
    const s = byStu[id];
    if (s.marks[day] !== 'absent') return;
    absentToday++;
    let streak = 0, from = day;
    for (const d of days) {
      const st = s.marks[d];
      if (st === undefined) continue;          // not marked that day (e.g. joined later) — skip, don't break
      if (st !== 'absent') break;
      streak++; from = d;
    }
    if (streak >= STREAK_MIN) list.push({ student_id: id, name: s.name, class: s.class, days: streak, since: from });
  });
  if (list.length) {
    // Has the parent applied for leave covering today?
    const ids = list.map(x => enc(x.student_id)).join(',');
    const leaves = await safe(sb('GET', 'leave_requests?school_code=eq.' + enc(schoolId) + '&student_id=in.(' + ids + ')' +
      '&status=in.(pending,approved)&from_date=lte.' + day + '&to_date=gte.' + day + '&select=student_id,status'), []) || [];
    const lv = {};
    leaves.forEach(l => { lv[String(l.student_id)] = l.status; });
    // Mobile number so the owner can call
    const stu = await safe(sb('GET', 'students?id=in.(' + ids + ')&select=id,mobile,section'), []) || [];
    const mob = {};
    stu.forEach(s => { mob[String(s.id)] = s; });
    list.forEach(x => {
      x.leave = lv[x.student_id] || '';
      const m = mob[x.student_id] || {};
      x.mobile = m.mobile || '';
      if (m.section && String(x.class).indexOf(' ' + m.section) === -1) x.class = clsText(x.class, m.section);
    });
  }
  list.sort((a, b) => b.days - a.days || String(a.class).localeCompare(String(b.class), undefined, { numeric: true }));
  return { taken_today: true, absent_today: absentToday, list };
}

// ── 3. New admission enquiries today (IST day) ──
async function enquiriesToday(schoolId, day) {
  const from = new Date(new Date(day + 'T00:00:00Z').getTime() - 5.5 * 3600 * 1000).toISOString();
  const to = new Date(new Date(day + 'T00:00:00Z').getTime() + DAY - 5.5 * 3600 * 1000).toISOString();
  const rows = await safe(sb('GET', 'admission_enquiries?school_id=eq.' + enc(schoolId) +
    '&created_at=gte.' + enc(from) + '&created_at=lt.' + enc(to) +
    '&select=parent_name,child_name,class_wanted,mobile,source,area&order=created_at.asc&limit=500'), []) || [];
  return { count: rows.length, list: rows.map(r => ({ child: r.child_name || '', parent: r.parent_name || '', class: r.class_wanted || '', mobile: r.mobile || '', source: r.source || '', area: r.area || '' })) };
}

// ── 4. New admissions today (students added to the ERP today) ──
async function admissionsToday(schoolId, day) {
  const from = new Date(new Date(day + 'T00:00:00Z').getTime() - 5.5 * 3600 * 1000).toISOString();
  const to = new Date(new Date(day + 'T00:00:00Z').getTime() + DAY - 5.5 * 3600 * 1000).toISOString();
  const rows = await safe(sb('GET', 'students?school_id=eq.' + enc(schoolId) + '&status=eq.active' +
    '&created_at=gte.' + enc(from) + '&created_at=lt.' + enc(to) +
    '&select=full_name,class,section,admission_no,father_name,mobile&order=created_at.asc&limit=500'), []) || [];
  return { count: rows.length, list: rows.map(r => ({ name: r.full_name || '', class: clsText(r.class, r.section), admission_no: r.admission_no || '', parent: r.father_name || '', mobile: r.mobile || '' })) };
}

async function buildReport(schoolId, day) {
  const [fees, absent, enquiries, admissions] = await Promise.all([
    feesToday(schoolId, day), longAbsent(schoolId, day), enquiriesToday(schoolId, day), admissionsToday(schoolId, day)
  ]);
  return { date: day, fees, absent, enquiries, admissions };
}

function summaryLine(r) {
  const parts = [];
  parts.push('Fees ' + inr(r.fees.total) + (r.fees.payers ? ' (' + r.fees.payers + ' paid)' : ''));
  if (r.absent.list.length) parts.push(r.absent.list.length + ' absent 3+ days');
  if (r.enquiries.count) parts.push(r.enquiries.count + ' new enquir' + (r.enquiries.count === 1 ? 'y' : 'ies'));
  if (r.admissions.count) parts.push(r.admissions.count + ' new admission' + (r.admissions.count === 1 ? '' : 's'));
  return parts.join(' · ');
}
function nothingHappened(r) {
  return !r.fees.total && !r.absent.taken_today && !r.enquiries.count && !r.admissions.count;
}

async function runSchool(schoolId, day, send) {
  const report = await buildReport(schoolId, day);
  if (nothingHappened(report)) return { skipped: 'nothing to report (holiday?)', report: send ? undefined : report };
  const sch = (await safe(sb('GET', 'schools?school_id=eq.' + enc(schoolId) + '&select=name&limit=1'), []) || [])[0] || {};
  const title = '📊 Today at ' + (sch.name || 'your school');
  const body = summaryLine(report);
  if (!send) return { title, body, report };

  const ins = await sb('POST', 'owner_alerts?on_conflict=school_id,kind,alert_date', [{
    school_id: schoolId, kind: 'evening_report', alert_date: day, title, body, data: report
  }], 'return=representation,resolution=ignore-duplicates').catch(() => []);
  if (!Array.isArray(ins) || !ins.length) return { already_sent: true };
  let phones = 0;
  if (pushReady()) {
    const subs = await safe(sb('GET', 'owner_push_subscriptions?school_id=eq.' + enc(schoolId) + '&select=id,endpoint,p256dh,auth'), []) || [];
    if (subs.length) {
      const out = await sendToSubs(subs, () => ({ title, body, tag: 'owner-evening-' + day,
        url: BASE + '/owner/index.html?alert=evening_report&date=' + day }), false);
      phones = out.sent;
    }
  }
  return { title, body, owner_phones: phones };
}

// Schools where at least one person has the Owner App
async function schoolsWithOwnerApp() {
  const rows = await sb('GET', 'owner_app_users?select=school_id&limit=5000') || [];
  return Array.from(new Set(rows.map(r => String(r.school_id))));
}

module.exports = async (req, res) => {
  if (!getServiceKey()) return res.status(500).json({ ok: false, error: 'Server key not configured.' });
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'GET only' });
  const secret = process.env.CRON_SECRET || '';
  const q = req.query || {};
  const auth = String(req.headers.authorization || '');
  if (!secret || (auth !== 'Bearer ' + secret && String(q.key || '') !== secret)) {
    return res.status(401).json({ ok: false, error: 'Not allowed.' });
  }
  const dry = q.dry === '1';
  const day = dry && /^\d{4}-\d{2}-\d{2}$/.test(String(q.date || '')) ? String(q.date) : istTodayIso();
  const out = { ok: true, date: day, dry, schools: {} };
  try {
    const ids = q.school ? [String(q.school)] : await schoolsWithOwnerApp();
    for (const id of ids) {
      try { out.schools[id] = await runSchool(id, day, !dry); }
      catch (e) { out.schools[id] = { ok: false, error: String(e.message || e) }; }
    }
    return res.status(200).json(out);
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};

module.exports.buildReport = buildReport;
