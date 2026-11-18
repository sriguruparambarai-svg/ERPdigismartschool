// DigiSmart ERP — "Not done yet" alerts (Nov 2026)
// Autopilot needs three daily steps done by people. When one is skipped, the principal is told the same day,
// and the owner is told only if it is still not done in the evening.
//
//   11 AM  → principal: classes whose attendance is not taken yet
//    3 PM  → principal: attendance still not taken + classes whose Daily Check Sheet is not in yet
//            (before the 4 PM parent messages go out)
//  4:30 PM → principal: teachers who didn't "Submit my day" in the Teacher App (after the school's deadline),
//            and on Mondays, last week's printed checklists not uploaded (from TeachBot, api/teachbot-link.js)
//          → owner: ONE alert only if anything is still not done
//
// Only steps the school / class actually uses are checked: a class that hasn't taken ERP attendance (or sent a
// check sheet) in the last 14 days is never "missing". A day with no attendance at all and a holiday notice is skipped.
//
// The principal is an Owner App person with role 'principal' (added by DigiSmart super admin in TeachBot).
//
// GET /api/not-done                    (Vercel cron 05:30 / 09:30 / 11:00 UTC, Mon–Sat, Bearer CRON_SECRET)
// GET /api/not-done?key=…&stage=am|pm|late&school=…&dry=1   → test run (dry = shows, sends nothing)
//
// Needs step-not-done.sql. Without it, attendance still works and the check sheet uses the defaulter marks.

const { sb, enc, getServiceKey, sendToSubs, pushReady, ownerSubs } = require('./_push');

const BASE = 'https://erp.digismartschool.com';
const LOOKBACK = 14;

function istNow() { return new Date(Date.now() + 5.5 * 3600 * 1000); }
function istToday() { return istNow().toISOString().slice(0, 10); }
function addDays(iso, n) { return new Date(new Date(iso + 'T00:00:00Z').getTime() + n * 86400000).toISOString().slice(0, 10); }
function stageNow() { const h = istNow().getUTCHours() + istNow().getUTCMinutes() / 60; return h < 13 ? 'am' : h < 16 ? 'pm' : 'late'; }
async function safe(p, dflt) { try { return await p; } catch (e) { return dflt; } }
async function getAll(path) {
  let out = [];
  for (let off = 0; off < 100000; off += 1000) {
    const rows = await sb('GET', path + '&limit=1000&offset=' + off) || [];
    out = out.concat(rows);
    if (rows.length < 1000) break;
  }
  return out;
}
const LADDER = ['PreKG', 'Pre KG', 'LKG', 'UKG'];
function classOrder(label) {
  const c = String(label).split(' ')[0] === 'Class' ? String(label).split(' ').slice(0, 2).join(' ') : String(label).split(' ')[0];
  const i = LADDER.indexOf(c); if (i !== -1) return i;
  const n = parseInt(String(label).replace(/\D+/g, ' ').trim(), 10);
  return isNaN(n) ? 99 : 10 + n;
}
const sortLabels = a => a.sort((x, y) => classOrder(x) - classOrder(y) || String(x).localeCompare(String(y)));
const label = (cls, sec) => String(cls || '').trim() + (sec && String(sec).trim() ? ' ' + String(sec).trim() : '');
function joinShort(list, n) { return list.length <= n ? list.join(', ') : list.slice(0, n).join(', ') + ' + ' + (list.length - n) + ' more'; }

// ── Attendance: classes that use ERP attendance but have nothing marked today ──
async function attendanceGap(schoolId, today) {
  const kids = await getAll('students?school_id=eq.' + enc(schoolId) + '&status=eq.active&select=id,class,section&order=id.asc');
  const of = {};
  kids.forEach(k => { of[String(k.id)] = label(k.class, k.section); });
  const rows = await getAll('student_attendance?school_id=eq.' + enc(schoolId) + '&date=gte.' + addDays(today, -LOOKBACK) +
    '&date=lte.' + today + '&select=student_id,date&order=id.asc');
  const used = new Set(), done = new Set();
  rows.forEach(r => { const l = of[String(r.student_id)]; if (!l) return; (String(r.date).slice(0, 10) === today ? done : used).add(l); });
  done.forEach(l => used.add(l));
  const missing = sortLabels([...used].filter(l => !done.has(l)));
  return { uses: used.size > 0, classes: used.size, marked: done.size, missing };
}

// ── Daily Check Sheet: classes that send a sheet but none came in today ──
async function sheetGap(schoolId, today) {
  const since = addDays(today, -LOOKBACK);
  const todayStart = new Date(today + 'T00:00:00+05:30').toISOString();
  const used = new Set(), done = new Set();
  const days = await safe(getAll('check_sheet_days?school_id=eq.' + enc(schoolId) + '&saved_on=gte.' + since + '&select=class,section,saved_on&order=saved_on.asc'), []);
  days.forEach(d => { const l = label(d.class, d.section); (String(d.saved_on).slice(0, 10) === today ? done : used).add(l); });
  // older sheets (before step-not-done.sql) left their mark only on the defaulter entries
  const marks = await safe(getAll('defaulter_entries?school_id=eq.' + enc(schoolId) + '&marked_by=like.' + enc('Check sheet*') +
    '&created_at=gte.' + enc(new Date(since + 'T00:00:00+05:30').toISOString()) + '&select=class,section,created_at&order=created_at.asc'), []);
  marks.forEach(m => { const l = label(m.class, m.section); (String(m.created_at) >= todayStart ? done : used).add(l); });
  done.forEach(l => used.add(l));
  const missing = sortLabels([...used].filter(l => !done.has(l)));
  return { uses: used.size > 0, classes: used.size, in: done.size, missing };
}

// A holiday notice whose last day is today or later, sent in the last 30 days
async function holidayNotice(schoolId, today) {
  const rows = await safe(sb('GET', 'communications?school_id=eq.' + enc(schoolId) + '&type=eq.holiday&event_date=gte.' + today +
    '&created_at=gte.' + enc(new Date(addDays(today, -30) + 'T00:00:00+05:30').toISOString()) + '&select=title&limit=1'), []) || [];
  return rows.length ? (rows[0].title || 'Holiday') : '';
}

async function teachersPart(schoolId, today) {
  const rows = await safe(sb('GET', 'not_done_feed?school_id=eq.' + enc(schoolId) + '&day=eq.' + today + '&part=eq.teachers&select=data&limit=1'), []) || [];
  return rows[0] ? rows[0].data || null : null;
}

async function raise(schoolId, who, kind, today, title, body, data, dry) {
  if (dry) return { kind, who, title, body };
  const ins = await sb('POST', 'owner_alerts?on_conflict=school_id,kind,alert_date', [{
    school_id: schoolId, kind, alert_date: today, title, body, data }], 'return=representation,resolution=ignore-duplicates').catch(() => []);
  if (!Array.isArray(ins) || !ins.length) return { kind, already_sent: true };
  let phones = 0;
  if (pushReady()) {
    const subs = await ownerSubs(schoolId, who);
    if (subs.length) {
      const out = await sendToSubs(subs, () => ({ title, body, tag: kind + '-' + today, url: BASE + '/owner/index.html?alert=' + kind + '&date=' + today }), true);
      phones = out.sent;
    }
  }
  return { kind, who, title, phones };
}

function attLine(att, when) {
  if (!att.missing.length) return '';
  if (!att.marked) return '📋 No class has taken attendance yet' + (when ? ' (' + when + ')' : '') + '.';
  return '📋 Attendance not taken: ' + joinShort(att.missing, 6) + '.';
}
function sheetLine(sh) { return sh.missing.length ? '📝 Check sheet not in: ' + joinShort(sh.missing, 6) + '.' : ''; }
function teacherLines(t) {
  if (!t) return [];
  const out = [];
  if ((t.day || []).length) out.push('👩‍🏫 Day not submitted: ' + joinShort(t.day.map(x => x.name), 5) + '.');
  if ((t.week || []).length) out.push('🗂 Last week\'s checklist not uploaded: ' + joinShort(t.week.map(x => x.name), 5) + '.');
  return out;
}

async function runSchool(schoolId, stage, today, dry) {
  const att = await attendanceGap(schoolId, today);
  if (att.uses && !att.marked) {
    const hol = await holidayNotice(schoolId, today);
    if (hol) return { skipped: 'holiday: ' + hol };
  }
  const sent = [];
  if (stage === 'am') {
    if (att.missing.length) {
      const body = attLine(att, 'by 11 AM') + (att.marked ? '' : ' If today is a holiday, ignore this.');
      sent.push(await raise(schoolId, 'principal', 'not_done_am', today, '⏰ Attendance not taken yet', body,
        { stage: 'am', attendance: att }, dry));
    }
    return { attendance: att, sent };
  }
  const sheet = await sheetGap(schoolId, today);
  if (stage === 'pm') {
    const lines = [attLine(att), sheetLine(sheet)].filter(Boolean);
    if (lines.length) {
      const body = lines.join(' ') + (sheet.missing.length ? ' Homework / test / discipline messages go to parents at 4 PM.' : '');
      sent.push(await raise(schoolId, 'principal', 'not_done_pm', today, '⏰ Not done yet — 3 PM', body,
        { stage: 'pm', attendance: att, sheet }, dry));
    }
    return { attendance: att, sheet, sent };
  }
  // late: teachers (principal) + anything still not done (owner)
  let t = await teachersPart(schoolId, today);
  if (t && !t.submitted && att.uses && !att.marked) t = null;   // nobody submitted and no attendance: no school today
  const tl = teacherLines(t);
  if (tl.length) {
    sent.push(await raise(schoolId, 'principal', 'not_done_teachers', today, '⏰ Teachers — not done today', tl.join(' '),
      { stage: 'late', teachers: t }, dry));
  }
  const all = [attLine(att), sheetLine(sheet)].concat(tl).filter(Boolean);
  if (all.length) {
    const nothing = att.uses && !att.marked && !sheet.in;
    sent.push(await raise(schoolId, 'owner', 'not_done_owner', today, '⚠️ Still not done today', all.join(' ') + (nothing ? ' If today was a holiday, ignore this.' : ''),
      { stage: 'late', attendance: att, sheet, teachers: t }, dry));
  }
  return { attendance: att, sheet, teachers: t, sent };
}

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
  if (!secret || (auth !== 'Bearer ' + secret && String(q.key || '') !== secret)) return res.status(401).json({ ok: false, error: 'Not allowed.' });
  const dry = q.dry === '1';
  const stage = ['am', 'pm', 'late'].indexOf(String(q.stage || '')) !== -1 ? String(q.stage) : stageNow();
  const today = istToday();
  const out = { ok: true, dry, stage, date: today, schools: {} };
  if (new Date(today + 'T00:00:00Z').getUTCDay() === 0) return res.status(200).json(Object.assign(out, { skipped: 'Sunday' }));
  try {
    const ids = q.school ? [String(q.school)] : await schoolsWithOwnerApp();
    for (const sid of ids) {
      try { out.schools[sid] = await runSchool(sid, stage, today, dry); }
      catch (e) { out.schools[sid] = { error: String(e.message || e) }; }
    }
  } catch (e) { out.ok = false; out.error = String(e.message || e); }
  return res.status(200).json(out);
};
module.exports.attendanceGap = attendanceGap;
module.exports.sheetGap = sheetGap;
