// DigiSmart ERP — Owner's weekly "children repeating problems" list (Nov 2026)
// Every Saturday at 7 PM India time the owner gets ONE short list in the Owner App — only children who
// repeated a problem this week (Monday to Saturday). No daily lists, so it is not tiring to read:
//   • Late 3 or more days            (student attendance)
//   • Absent 3 or more days          (student attendance; shows if the parent applied for leave)
//   • Homework not done 3+ times     (Homework Defaulters)
//   • Class test not written / absent / low marks 2+ times
//   • Discipline 3+ times
// Each child appears once, with all their problems, the parent's phone, and whether the parent tapped
// "I have seen" on this week's warning. Only schools with at least one Owner App person get it.
//
// GET /api/weekly-repeats                              (Vercel cron 13:30 UTC Saturday = 7 PM IST, Bearer CRON_SECRET)
// GET /api/weekly-repeats?key=…&school=…&dry=1&date=YYYY-MM-DD   → test run, nothing saved or sent

const { sb, enc, getServiceKey, sendToSubs, pushReady, ownerSubs } = require('./_push');

const BASE = 'https://erp.digismartschool.com';
const LIMIT = { late: 3, absent: 3, homework: 3, test: 2, discipline: 3 };
const TEST_KINDS = ['test_not_written', 'test_absent', 'test_low_marks'];

function istTodayIso() { return new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10); }
function addDays(iso, n) { return new Date(new Date(iso + 'T00:00:00Z').getTime() + n * 86400000).toISOString().slice(0, 10); }
function mondayOf(iso) { const d = new Date(iso + 'T00:00:00Z'); return addDays(iso, -((d.getUTCDay() + 6) % 7)); }
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

async function buildWeek(schoolId, day) {
  const from = mondayOf(day), to = addDays(from, 5);
  const kids = {};
  const kid = (id, name, cls) => (kids[id] = kids[id] || { id, name: name || '', class: cls || '', late: 0, absent: 0, homework: 0, test: 0, discipline: 0, test_detail: [] });

  // 1. Attendance: late and absent days
  const att = await safe(getAll('student_attendance?school_id=eq.' + enc(schoolId) + '&date=gte.' + from + '&date=lte.' + to +
    '&select=student_id,student_name,class,date,status'), []);
  const seenDay = {};
  att.forEach(r => {
    if (!r.student_id) return;
    const k = String(r.student_id) + '|' + String(r.date).slice(0, 10);
    if (seenDay[k]) return; seenDay[k] = 1;   // one mark per child per day
    const s = kid(String(r.student_id), r.student_name, r.class);
    if (r.status === 'late') s.late++;
    if (r.status === 'absent') s.absent++;
  });

  // 2. Homework, class tests, discipline marked this week (waiting or sent)
  const marks = await safe(getAll('defaulter_entries?school_id=eq.' + enc(schoolId) + '&work_date=gte.' + from + '&work_date=lte.' + to +
    '&select=student_id,student_name,class,section,kind,subject,work_date'), []);
  marks.forEach(m => {
    const s = kid(String(m.student_id), m.student_name, m.class + (m.section && m.section !== 'A' ? ' ' + m.section : ''));
    if (m.kind === 'homework') s.homework++;
    else if (m.kind === 'discipline') s.discipline++;
    else if (TEST_KINDS.indexOf(m.kind) !== -1) {
      s.test++;
      s.test_detail.push(m.subject + (m.kind === 'test_absent' ? ' (absent)' : m.kind === 'test_low_marks' ? ' (low marks)' : ' (not written)'));
    }
  });

  // Only children over a limit
  const list = Object.values(kids).filter(s => Object.keys(LIMIT).some(k => s[k] >= LIMIT[k]));
  if (list.length) {
    const ids = list.map(x => enc(x.id)).join(',');
    const stu = await safe(sb('GET', 'students?id=in.(' + ids + ')&select=id,mobile,section,full_name'), []) || [];
    const by = {}; stu.forEach(s => { by[String(s.id)] = s; });
    const leaves = await safe(sb('GET', 'leave_requests?school_code=eq.' + enc(schoolId) + '&student_id=in.(' + ids + ')' +
      '&status=in.(pending,approved)&from_date=lte.' + to + '&to_date=gte.' + from + '&select=student_id,status'), []) || [];
    const lv = {}; leaves.forEach(l => { if (lv[String(l.student_id)] !== 'approved') lv[String(l.student_id)] = l.status; });
    const reps = await safe(sb('GET', 'defaulter_repeats?school_id=eq.' + enc(schoolId) + '&student_id=in.(' + ids + ')' +
      '&sent_at=gte.' + enc(from + 'T00:00:00+05:30') + '&select=student_id,ack_at'), []) || [];
    const ack = {}; reps.forEach(r => { const k = String(r.student_id); ack[k] = ack[k] === 'not_seen' ? 'not_seen' : (r.ack_at ? 'seen' : 'not_seen'); });
    list.forEach(x => {
      const s = by[x.id] || {};
      x.mobile = s.mobile || '';
      if (!x.name && s.full_name) x.name = s.full_name;
      if (s.section && s.section !== 'A' && String(x.class).indexOf(' ' + s.section) === -1) x.class += ' ' + s.section;
      x.leave = x.absent >= LIMIT.absent ? (lv[x.id] || '') : '';
      x.parent = ack[x.id] || '';
      x.problems = Object.keys(LIMIT).filter(k => x[k] >= LIMIT[k]).length;
    });
  }
  list.sort((a, b) => b.problems - a.problems || String(a.class).localeCompare(String(b.class), undefined, { numeric: true }) || String(a.name).localeCompare(String(b.name)));
  const counts = {};
  Object.keys(LIMIT).forEach(k => { counts[k] = list.filter(x => x[k] >= LIMIT[k]).length; });
  return { from, to, limits: LIMIT, counts, attendance_taken: att.length > 0, list };
}

function summary(r) {
  const n = { late: 'late', absent: 'absent', homework: 'homework', test: 'class tests', discipline: 'discipline' };
  const parts = Object.keys(n).filter(k => r.counts[k]).map(k => r.counts[k] + ' ' + n[k]);
  return parts.length ? parts.join(' · ') : 'No child repeated a problem this week ✅';
}

async function runSchool(schoolId, day, send) {
  const report = await buildWeek(schoolId, day);
  if (!report.attendance_taken && !report.list.length) return { skipped: 'no school this week (holiday?)', report: send ? undefined : report };
  const sch = (await safe(sb('GET', 'schools?school_id=eq.' + enc(schoolId) + '&select=name&limit=1'), []) || [])[0] || {};
  const title = report.list.length ? '📋 ' + report.list.length + ' child' + (report.list.length === 1 ? '' : 'ren') + ' repeating problems this week' : '📋 This week at ' + (sch.name || 'school');
  const body = summary(report);
  if (!send) return { title, body, report };
  const ins = await sb('POST', 'owner_alerts?on_conflict=school_id,kind,alert_date', [{
    school_id: schoolId, kind: 'weekly_repeats', alert_date: day, title, body, data: report
  }], 'return=representation,resolution=ignore-duplicates').catch(() => []);
  if (!Array.isArray(ins) || !ins.length) return { already_sent: true };
  let phones = 0;
  if (pushReady()) {
    const subs = await ownerSubs(schoolId, 'owner') || [];
    if (subs.length) {
      const out = await sendToSubs(subs, () => ({ title, body, tag: 'owner-weekly-' + day,
        url: BASE + '/owner/index.html?alert=weekly_repeats&date=' + day }), false);
      phones = out.sent;
    }
  }
  return { title, body, owner_phones: phones };
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
  const day = dry && /^\d{4}-\d{2}-\d{2}$/.test(String(q.date || '')) ? String(q.date) : istTodayIso();
  const out = { ok: true, date: day, dry, schools: {} };
  try {
    const ids = q.school ? [String(q.school)] : await schoolsWithOwnerApp();
    for (const id of ids) {
      try { out.schools[id] = await runSchool(id, day, !dry); }
      catch (e) { out.schools[id] = { ok: false, error: String(e.message || e) }; }
    }
  } catch (e) { out.ok = false; out.error = String(e.message || e); }
  return res.status(200).json(out);
};
