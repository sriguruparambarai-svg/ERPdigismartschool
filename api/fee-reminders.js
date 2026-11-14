// DigiSmart ERP — Automatic Fee Reminders (Nov 2026)
// The ERP on autopilot: nobody has to open Defaulters and press a button.
//
// Every morning, for every school that has switched it on (Fee Settings →
// Automatic Fee Reminders), each child's dues are worked out with the SAME
// calculator the fee counter and online payment use (api/_fees.js), and:
//   • BEFORE the due date (default 5 days before, and on the due day) the
//     parent gets "fee due on …" with every month / term and its amount;
//   • AFTER the due date (default 3 days after, then every 7 days until paid)
//     the parent gets "fee pending" listing every unpaid month / term,
//     its amount, and any late fee — so 2–3 months unpaid shows all of them;
//   • the owner gets ONE alert in the Owner App: "Fee reminders sent to 23
//     parents · ₹1,84,500", which opens the full list (who, class, months,
//     amount, whether the parent has the app, whether they have seen it).
// A child gets at most one reminder a day. A fee paid before the day stops it.
//
// GET  /api/fee-reminders                  (Vercel cron, Bearer CRON_SECRET) → send today's
// GET  /api/fee-reminders?key=…&school=…&dry=1&date=YYYY-MM-DD  → test run, nothing sent
// POST { token (owner / Fee Full), action: 'preview', date? } → what would go on that day
// POST { token (owner / Fee Full), action: 'history', date? } → what went on that day

const crypto = require('crypto');
const { computeSchoolDues, istToday } = require('./_fees');
const { sb, enc, getServiceKey, sendToSubs, subsForStudents, pushReady } = require('./_push');
const { both, feeReminderTamil, taDate } = require('./_tamil');

const BASE = 'https://erp.digismartschool.com';
const DAY = 86400000;

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

function inr(n) { return '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 }); }
function niceDate(iso) {
  const d = new Date(String(iso).slice(0, 10) + 'T00:00:00Z');
  if (isNaN(d.getTime())) return String(iso || '');
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}
function isoOf(d) { return d.toISOString().slice(0, 10); }
function daysBetween(fromIso, toIso) {
  return Math.round((new Date(toIso + 'T00:00:00Z') - new Date(fromIso + 'T00:00:00Z')) / DAY);
}
function classText(stu) { return String(stu.class || '') + (stu.section ? ' ' + stu.section : ''); }

// ── Decide, for one child, whether today is a reminder day and what it says ──
// items: from duesFrom() — each with amount, period, group and due (YYYY-MM-DD or null)
function planForChild(stu, items, cfg, todayIso) {
  const dated = items.filter(it => it.group !== 'late' && it.due);
  if (!dated.length) return null;
  const maxBefore = cfg.before.length ? Math.max.apply(null, cfg.before) : 0;

  let triggerBefore = false, triggerAfter = false, oldest = 0;
  dated.forEach(it => {
    const left = daysBetween(todayIso, String(it.due).slice(0, 10));   // days until due (negative = overdue)
    if (left >= 0 && cfg.before.indexOf(left) !== -1) triggerBefore = true;
    if (left < 0) {
      const late = -left;
      if (late === cfg.after_first) triggerAfter = true;              // a new month / term just went overdue
      if (late > oldest) oldest = late;
    }
  });
  // Then every few days, counted from the oldest unpaid fee, until it is paid
  if (oldest > cfg.after_first && (oldest - cfg.after_first) % cfg.after_every === 0) triggerAfter = true;
  if (!triggerBefore && !triggerAfter) return null;

  // What goes in the message: everything overdue, everything falling due within
  // the "before" window, and the late fees on those
  const take = dated.filter(it => daysBetween(todayIso, String(it.due).slice(0, 10)) <= maxBefore);
  const takePeriods = {};
  take.forEach(it => { if (it.group === 'fee') takePeriods[it.period] = true; });
  const late = items.filter(it => it.group === 'late' && takePeriods[it.period]);
  if (!take.length) return null;

  // One line per term / month, e.g. "Term 2 fees (Tuition, Books): ₹12,000",
  // "Van fee – October: ₹800", "Late fee – Term 2: ₹200"
  const groups = {};
  take.concat(late).forEach(it => {
    const k = it.group + '|' + it.period;
    if (!groups[k]) groups[k] = { group: it.group, period: it.period, due: it.due, amount: 0, heads: [] };
    const g = groups[k];
    g.amount += Number(it.amount) || 0;
    if (it.group === 'fee' && it.fee_head_name && g.heads.indexOf(it.fee_head_name) === -1) g.heads.push(it.fee_head_name);
  });
  const lines = Object.keys(groups).map(k => groups[k]).sort((a, b) => {
    if (a.group === 'late' && b.group !== 'late') return 1;
    if (b.group === 'late' && a.group !== 'late') return -1;
    return String(a.due || '').localeCompare(String(b.due || ''));
  }).map(g => {
    let text;
    if (g.group === 'fee') text = g.period + ' fees' + (g.heads.length ? ' (' + g.heads.join(', ') + ')' : '');
    else if (g.group === 'van') text = g.period === 'One-Time' ? 'Van fee (one-time plan)' : 'Van fee – ' + g.period;
    else text = 'Late fee – ' + g.period;
    const amount = Math.round(g.amount * 100) / 100;
    return { text, amount, due: g.due || null, overdue: !!(g.due && g.group !== 'late' && daysBetween(todayIso, String(g.due).slice(0, 10)) < 0) };
  });
  const total = Math.round(lines.reduce((s, l) => s + l.amount, 0) * 100) / 100;
  const overdue = lines.some(l => l.overdue || l.text.indexOf('Late fee') === 0);
  const nextDue = lines.filter(l => !l.overdue && l.due).map(l => String(l.due).slice(0, 10)).sort()[0] || null;
  return { kind: overdue ? 'after' : 'before', lines, total, next_due: nextDue };
}

function buildMessage(schoolName, stu, plan, tamil) {
  const name = String(stu.full_name || '').trim() || 'your child';
  const list = plan.lines.map(l => '• ' + l.text + (l.due && l.text.indexOf('Late fee') !== 0 ? ' (due ' + niceDate(l.due) + ')' : '') + ': ' + inr(l.amount)).join('\n');
  let en;
  if (plan.kind === 'before') {
    en = 'Fee reminder from ' + schoolName + '\n' + name + ' (' + classText(stu) + ') — fee due on ' + niceDate(plan.next_due) + ':\n'
      + list + '\nTotal: ' + inr(plan.total) + '\nKindly pay on or before the due date. If already paid, please ignore.';
  } else {
    en = 'Fee pending — ' + schoolName + '\n' + name + ' (' + classText(stu) + ') has the following fees unpaid:\n'
      + list + '\nTotal: ' + inr(plan.total) + '\nKindly pay at the earliest. If already paid, please ignore.';
  }
  if (!tamil) return en;
  return both(en, feeReminderTamil(plan.kind, name, inr(plan.total), plan.next_due));
}

function shortAlert(stu, plan) {
  const first = String(stu.full_name || '').trim().split(/\s+/)[0] || 'your child';
  const what = plan.lines.filter(l => l.text.indexOf('Late fee') !== 0).map(l => l.text.replace(/ \(.*\)$/, '').replace(' fees', '')).slice(0, 4).join(', ');
  if (plan.kind === 'before') {
    return { title: '💰 Fee due on ' + niceDate(plan.next_due), body: first + ': ' + inr(plan.total) + ' (' + what + '). Tap to see details.' };
  }
  return { title: '⚠️ Fee pending', body: first + ': ' + inr(plan.total) + ' unpaid (' + what + '). Tap to see details.' };
}

// ── One school, one day ──
// send=false → only works out what would go (nothing saved, nothing sent)
async function runSchool(schoolId, todayIso, send) {
  const { ctx, results } = await computeSchoolDues(sb, schoolId);
  const cfg = ctx.reminders;
  const sch = (await sb('GET', 'schools?or=(school_id.eq.' + enc(schoolId) + ',school_code.eq.' + enc(schoolId) + ')&select=name,has_tamil_msgs&limit=1').catch(() => null) || [])[0]
    || (await sb('GET', 'schools?or=(school_id.eq.' + enc(schoolId) + ',school_code.eq.' + enc(schoolId) + ')&select=name&limit=1').catch(() => null) || [])[0] || {};
  const schoolName = sch.name || 'School';
  const tamil = !!sch.has_tamil_msgs;

  // Not two days running: a child reminded in the last 2 days is left alone today
  const twoAgo = isoOf(new Date(new Date(todayIso + 'T00:00:00Z').getTime() - 2 * DAY));
  const recent = new Set(((await sb('GET', 'fee_auto_reminders?school_id=eq.' + enc(schoolId) + '&sent_on=gte.' + twoAgo +
    '&sent_on=lt.' + todayIso + '&select=student_id').catch(() => [])) || []).map(r => String(r.student_id)));

  const planned = [];
  results.forEach(r => {
    if (!r.items.length || recent.has(String(r.student.id))) return;
    const plan = planForChild(r.student, r.items, cfg, todayIso);
    if (plan) planned.push({ stu: r.student, plan });
  });

  // Which parents have the app with alerts on
  const subs = planned.length && pushReady() ? await subsForStudents(planned.map(p => p.stu.id)) : [];
  const subsBy = {};
  subs.forEach(s => { (subsBy[String(s.student_id)] = subsBy[String(s.student_id)] || []).push(s); });

  const list = [];
  let sentPhones = 0, already = 0;
  for (const p of planned) {
    const mine = subsBy[String(p.stu.id)] || [];
    const message = buildMessage(schoolName, p.stu, p.plan, tamil);
    const row = {
      school_id: schoolId, student_id: p.stu.id, sent_on: todayIso, kind: p.plan.kind,
      student_name: p.stu.full_name || '', student_class: classText(p.stu), mobile: p.stu.mobile || '',
      lines: p.plan.lines, total: p.plan.total, message, has_app: mine.length > 0
    };
    if (send) {
      // Saved first; the database refuses a second one for this child today
      const saved = await sb('POST', 'fee_auto_reminders?on_conflict=school_id,student_id,sent_on', [row],
        'return=representation,resolution=ignore-duplicates').catch(() => []);
      if (!Array.isArray(saved) || !saved.length) { already++; continue; }
      if (mine.length) {
        const a = shortAlert(p.stu, p.plan);
        const out = await sendToSubs(mine, () => ({
          title: a.title, body: a.body, tag: 'fee-' + p.stu.id + '-' + todayIso,
          url: BASE + '/parent/dashboard.html?child=' + enc(p.stu.id)
        }), p.plan.kind === 'after');
        sentPhones += out.sent;
      }
    }
    list.push({ student_id: p.stu.id, name: row.student_name, class: row.student_class, mobile: p.stu.mobile || '',
      kind: row.kind, lines: row.lines, total: row.total, has_app: row.has_app, message: send ? undefined : message });
  }

  const total = Math.round(list.reduce((s, x) => s + (Number(x.total) || 0), 0) * 100) / 100;
  const noApp = list.filter(x => !x.has_app).length;
  const summary = {
    date: todayIso, reminders: list.length, total, no_app: noApp,
    before: list.filter(x => x.kind === 'before').length, after: list.filter(x => x.kind === 'after').length
  };

  // ── The owner's copy: one alert for the whole batch ──
  if (send && list.length) {
    const title = '💰 Fee reminders sent';
    const body = list.length + ' parent' + (list.length === 1 ? '' : 's') + ' · ' + inr(total)
      + (summary.after ? ' · ' + summary.after + ' overdue' : '')
      + (noApp ? ' · ' + noApp + ' without the parent app (please call)' : '');
    const ins = await sb('POST', 'owner_alerts?on_conflict=school_id,kind,alert_date', [{
      school_id: schoolId, kind: 'fee_reminders', alert_date: todayIso, title, body, data: summary
    }], 'return=representation,resolution=ignore-duplicates').catch(() => []);
    if (Array.isArray(ins) && ins.length && pushReady()) {
      const osubs = await sb('GET', 'owner_push_subscriptions?school_id=eq.' + enc(schoolId) + '&select=id,endpoint,p256dh,auth').catch(() => []) || [];
      if (osubs.length) {
        const out = await sendToSubs(osubs, () => ({
          title, body, tag: 'owner-fee-' + todayIso,
          url: BASE + '/owner/index.html?alert=fee_reminders&date=' + todayIso
        }), true);
        summary.owner_phones = out.sent;
      } else summary.owner_phones = 0;
    }
  }

  summary.parent_phones = sentPhones;
  if (already) summary.already_sent = already;
  return { summary, list, settings: cfg };
}

// Schools that have switched automatic reminders on
async function schoolsOn() {
  const rows = await sb('GET', 'fee_settings?select=school_id,auto_reminders&auto_reminders=not.is.null') || [];
  return rows.filter(r => {
    let c = r.auto_reminders;
    if (typeof c === 'string') { try { c = JSON.parse(c); } catch (e) { c = null; } }
    return c && c.on;
  }).map(r => String(r.school_id));
}

function goodDate(d) { return /^\d{4}-\d{2}-\d{2}$/.test(String(d || '')) ? String(d) : null; }

module.exports = async (req, res) => {
  if (!getServiceKey()) return res.status(500).json({ ok: false, error: 'Server key not configured.' });
  const todayIso = isoOf(istToday());

  // ── Cron (and manual test runs) ──
  if (req.method === 'GET') {
    const secret = process.env.CRON_SECRET || '';
    const q = req.query || {};
    const auth = String(req.headers.authorization || '');
    if (!secret || (auth !== 'Bearer ' + secret && String(q.key || '') !== secret)) {
      return res.status(401).json({ ok: false, error: 'Not allowed.' });
    }
    const dry = q.dry === '1';
    const day = dry ? (goodDate(q.date) || todayIso) : todayIso;   // another date only for a test run
    const out = { ok: true, date: day, dry, schools: {} };
    try {
      const ids = q.school ? [String(q.school)] : await schoolsOn();
      for (const id of ids) {
        try {
          const r = await runSchool(id, day, !dry);
          out.schools[id] = dry ? r : r.summary;
        } catch (e) { out.schools[id] = { ok: false, error: String(e.message || e) }; }
      }
      return res.status(200).json(out);
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e.message || e) });
    }
  }

  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); }
  catch (e) { return res.status(400).json({ ok: false, error: 'Invalid request.' }); }

  const session = verifyToken(body.token);
  if (!session || !session.sid) return res.status(401).json({ ok: false, error: 'Session expired. Please log in again.' });
  const mods = Array.isArray(session.mods) ? session.mods : [];
  if (!(session.role === 'owner' || session.role === 'owner_app' || mods.indexOf('fee') !== -1)) {
    return res.status(403).json({ ok: false, error: 'Only the owner or Fee Management (Full) staff can see fee reminders.' });
  }
  const schoolId = String(session.sid);

  try {
    if (body.action === 'preview') {
      const day = goodDate(body.date) || todayIso;
      const r = await runSchool(schoolId, day, false);
      return res.status(200).json({ ok: true, date: day, summary: r.summary, list: r.list, settings: r.settings });
    }
    if (body.action === 'history') {
      const day = goodDate(body.date) || todayIso;
      const rows = await sb('GET', 'fee_auto_reminders?school_id=eq.' + enc(schoolId) + '&sent_on=eq.' + day +
        '&select=student_id,student_name,student_class,mobile,kind,lines,total,has_app,seen_at&order=student_class.asc,student_name.asc') || [];
      return res.status(200).json({ ok: true, date: day, list: rows });
    }
    return res.status(400).json({ ok: false, error: 'Unknown action.' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};

// For tests
module.exports.planForChild = planForChild;
module.exports.buildMessage = buildMessage;
