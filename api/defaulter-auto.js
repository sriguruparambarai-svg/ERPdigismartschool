// DigiSmart ERP — Defaulters on autopilot (Nov 2026)
// Every school day at 4 PM India time (with the homework), without anyone pressing a button:
//   1. Every homework / class test / discipline message still waiting goes to the parent app
//      (the same as the office's "Send all to parents"), with a phone alert.
//   2. Repeat defaulters: a child marked 3 times in the last 7 days — homework, class test and
//      discipline counted separately — gets ONE message listing them, which the parent must
//      acknowledge with "I have seen". Each mark is counted in one such message only.
//      If the parent doesn't tap it within 2 days, the office sees it in Homework Defaulters →
//      📞 Parents to call, and the owner sees it in the 6 PM evening report.
//
// GET /api/defaulter-auto                         (Vercel cron 10:30 UTC = 4 PM IST, Mon–Sat, Bearer CRON_SECRET)
// GET /api/defaulter-auto?key=…&school=…&dry=1   → test run: shows what would happen, sends nothing
//
// Needs step-check-sheet.sql (the defaulter_repeats table). Without it, step 1 still works.

const { sb, enc, getServiceKey, sendToSubs, logOnce, pushReady } = require('./_push');
const { both, taDate, DISCIPLINE } = require('./_tamil');

const BASE = 'https://erp.digismartschool.com';
const REPEAT_TIMES = 3;   // marks …
const REPEAT_DAYS = 7;    // … within this many days
const GROUP = { homework: 'homework', test_not_written: 'test', test_absent: 'test', test_low_marks: 'test', discipline: 'discipline' };

function istToday() { return new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10); }
function addDays(iso, n) { return new Date(new Date(iso + 'T00:00:00Z').getTime() + n * 86400000).toISOString().slice(0, 10); }
function niceDate(s) { const m = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']; const d = new Date(s + 'T00:00:00Z'); return d.getUTCDate() + ' ' + m[d.getUTCMonth()]; }
function short(t, n) { t = String(t || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; }
function parentUrl(schoolId, studentId) { return studentId ? BASE + '/parent/dashboard.html?child=' + encodeURIComponent(studentId) : BASE + '/parent/index.html?school=' + encodeURIComponent(schoolId); }
async function getAll(path) {
  let out = [];
  for (let off = 0; off < 50000; off += 1000) {
    const rows = await sb('GET', path + '&limit=1000&offset=' + off) || [];
    out = out.concat(rows);
    if (rows.length < 1000) break;
  }
  return out;
}
async function tamilSchools() {
  const rows = await sb('GET', 'schools?has_tamil_msgs=eq.true&select=school_id').catch(() => []) || [];
  return new Set(rows.map(r => String(r.school_id)));
}

// ── 1. Send everything waiting ──
async function sendWaiting(dry) {
  const today = istToday();
  const pending = await getAll('defaulter_entries?status=eq.pending&work_date=lte.' + today + '&select=id,school_id,student_id,student_name,kind,subject,message&order=created_at.asc');
  const bySchool = {};
  pending.forEach(p => { (bySchool[p.school_id] = bySchool[p.school_id] || []).push(p); });
  const report = {};
  for (const sid of Object.keys(bySchool)) {
    const list = bySchool[sid];
    if (dry) { report[sid] = { would_send: list.length }; continue; }
    const sent = [];
    for (let i = 0; i < list.length; i += 80) {
      const part = list.slice(i, i + 80);
      const r = await sb('PATCH', 'defaulter_entries?school_id=eq.' + enc(sid) + '&status=eq.pending&id=in.(' + part.map(x => enc(x.id)).join(',') + ')',
        { status: 'sent', sent_at: new Date().toISOString() }).catch(() => null);
      (r || []).forEach(x => sent.push(x));
    }
    let phones = 0;
    if (pushReady() && sent.length) {
      const stuIds = [...new Set(sent.map(r => String(r.student_id)))];
      let subs = [];
      for (let i = 0; i < stuIds.length; i += 80) {
        subs = subs.concat(await sb('GET', 'push_subscriptions?school_id=eq.' + enc(sid) + '&student_id=in.(' + stuIds.slice(i, i + 80).map(enc).join(',') + ')&select=id,student_id,endpoint,p256dh,auth').catch(() => []) || []);
      }
      const heads = { homework: '📚 Homework not written', test_not_written: '📝 Class test', test_absent: '📝 Absent for class test', test_low_marks: '📝 Class test marks', discipline: '👔 Discipline note' };
      for (const d of sent) {
        const mine = subs.filter(s => String(s.student_id) === String(d.student_id));
        if (!mine.length) continue;
        if (!(await logOnce(sid, 'defaulter', String(d.id)))) continue;
        const out = await sendToSubs(mine, () => ({
          title: (heads[d.kind] || '📝 Message from school') + (d.student_name ? ' · ' + d.student_name : '') + (d.kind === 'discipline' ? '' : ' · ' + short(d.subject, 30)),
          body: /[஀-௿]/.test(d.message || '') ? short(d.message, 400) : short(d.message, 160),
          tag: 'defaulter-' + d.id, url: parentUrl(sid, d.student_id)
        }), false);
        phones += out.sent;
      }
    }
    report[sid] = { sent: sent.length, phone_alerts: phones };
  }
  return report;
}

// ── 2. Repeat defaulters ──
function repeatMessage(group, name, marks, tamil) {
  const n = marks.length;
  const enList = marks.slice(0, 8).map(m => m.kind === 'discipline'
    ? (m.items || []).map(c => (DISCIPLINE[c] ? DISCIPLINE[c][0].toLowerCase() : c)).join(', ') + ' (' + niceDate(m.work_date) + ')'
    : m.subject + (m.kind === 'test_absent' ? ' – absent' : m.kind === 'test_low_marks' ? ' – low marks' : '') + ' (' + niceDate(m.work_date) + ')').join('; ');
  const taList = marks.slice(0, 8).map(m => m.kind === 'discipline'
    ? (m.items || []).map(c => (DISCIPLINE[c] ? DISCIPLINE[c][2] : c)).join(', ') + ' (' + taDate(m.work_date) + ')'
    : m.subject + ' (' + taDate(m.work_date) + ')').join('; ');
  let en, ta;
  if (group === 'homework') {
    en = 'Dear Parent, ' + name + ' did not do the homework ' + n + ' times this week: ' + enList + '. Please check your child\'s homework every day. Tap "I have seen" below to let the school know you have read this.';
    ta = 'அன்புள்ள பெற்றோரே, ' + name + ' இந்த வாரம் ' + n + ' முறை வீட்டுப்பாடம் செய்யவில்லை: ' + taList + '. தினமும் உங்கள் குழந்தையின் வீட்டுப்பாடத்தைச் சரிபார்க்கவும். படித்ததும் கீழே உள்ள "பார்த்தேன்" பொத்தானை அழுத்தவும்.';
  } else if (group === 'test') {
    en = 'Dear Parent, ' + name + ' did not write, was absent for, or scored low in class tests ' + n + ' times this week: ' + enList + '. Please help your child prepare for tests. Tap "I have seen" below to let the school know you have read this.';
    ta = 'அன்புள்ள பெற்றோரே, ' + name + ' இந்த வாரம் ' + n + ' முறை வகுப்புத் தேர்வை எழுதவில்லை / வரவில்லை / குறைந்த மதிப்பெண்: ' + taList + '. தேர்வுக்குப் படிக்க உதவவும். படித்ததும் கீழே உள்ள "பார்த்தேன்" பொத்தானை அழுத்தவும்.';
  } else {
    en = 'Dear Parent, ' + name + ' came to school without following the school rules ' + n + ' times this week: ' + enList + '. Please send your child neatly every day. Tap "I have seen" below to let the school know you have read this.';
    ta = 'அன்புள்ள பெற்றோரே, ' + name + ' இந்த வாரம் ' + n + ' முறை பள்ளி விதிகளைப் பின்பற்றாமல் வந்தார்: ' + taList + '. தினமும் ஒழுங்காக அனுப்பவும். படித்ததும் கீழே உள்ள "பார்த்தேன்" பொத்தானை அழுத்தவும்.';
  }
  return tamil ? both(en, ta) : en;
}

async function findRepeats(dry, onlySchool) {
  const today = istToday(), from = addDays(today, -(REPEAT_DAYS - 1));
  const marks = await getAll('defaulter_entries?status=eq.sent&work_date=gte.' + from + (onlySchool ? '&school_id=eq.' + enc(onlySchool) : '')
    + '&select=id,school_id,student_id,student_name,class,section,kind,subject,work_date,items&order=work_date.asc');
  if (!marks.length) return {};
  // marks already counted in an earlier repeat message are not counted again
  const schools = [...new Set(marks.map(m => String(m.school_id)))];
  const since = new Date(Date.now() - 30 * 86400000).toISOString();
  const counted = new Set();
  for (const sid of schools) {
    let old;
    try { old = await sb('GET', 'defaulter_repeats?school_id=eq.' + enc(sid) + '&sent_at=gte.' + enc(since) + '&select=entry_ids&limit=5000'); }
    catch (e) { throw new Error('Could not read repeat messages (has step-check-sheet.sql been run in Supabase?): ' + e.message); }
    (old || []).forEach(o => (o.entry_ids || []).forEach(id => counted.add(String(id))));
  }
  const groups = {};
  marks.forEach(m => {
    if (counted.has(String(m.id))) return;
    const g = GROUP[m.kind];
    if (!g) return;
    const k = m.school_id + '|' + m.student_id + '|' + g;
    (groups[k] = groups[k] || { school_id: String(m.school_id), student_id: String(m.student_id), student_name: m.student_name, class: m.class, section: m.section, group: g, marks: [] }).marks.push(m);
  });
  const ta = await tamilSchools();
  const report = {};
  for (const g of Object.values(groups)) {
    if (g.marks.length < REPEAT_TIMES) continue;
    const message = repeatMessage(g.group, g.student_name || 'your ward', g.marks, ta.has(g.school_id));
    const rep = report[g.school_id] = report[g.school_id] || { messages: 0, phone_alerts: 0, list: [] };
    rep.list.push({ child: g.student_name, class: g.class + (g.section ? ' ' + g.section : ''), group: g.group, times: g.marks.length });
    if (dry) { rep.messages++; continue; }
    const ins = await sb('POST', 'defaulter_repeats', [{ school_id: g.school_id, student_id: g.student_id, student_name: g.student_name,
      class: g.class, section: g.section, kind_group: g.group, times: g.marks.length, entry_ids: g.marks.map(m => String(m.id)), message: message }]).catch(e => { rep.error = String(e.message || e); return null; });
    const row = Array.isArray(ins) ? ins[0] : null;
    if (!row) continue;
    rep.messages++;
    if (pushReady()) {
      const subs = await sb('GET', 'push_subscriptions?school_id=eq.' + enc(g.school_id) + '&student_id=eq.' + enc(g.student_id) + '&select=id,student_id,endpoint,p256dh,auth').catch(() => []) || [];
      if (subs.length && await logOnce(g.school_id, 'repeat', String(row.id))) {
        const out = await sendToSubs(subs, () => ({ title: '⚠️ Please read · ' + (g.student_name || 'your child'),
          body: /[஀-௿]/.test(message) ? short(message, 400) : short(message, 180), tag: 'repeat-' + row.id, url: parentUrl(g.school_id, g.student_id) }), true);
        rep.phone_alerts += out.sent;
      }
    }
  }
  return report;
}

module.exports = async (req, res) => {
  if (!getServiceKey()) return res.status(500).json({ ok: false, error: 'Server key not configured.' });
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'GET only' });
  const secret = process.env.CRON_SECRET || '';
  const q = req.query || {};
  const auth = String(req.headers.authorization || '');
  if (!secret || (auth !== 'Bearer ' + secret && String(q.key || '') !== secret)) return res.status(401).json({ ok: false, error: 'Not allowed.' });
  const dry = q.dry === '1';
  const out = { ok: true, dry: dry, date: istToday() };
  try { out.sent = await sendWaiting(dry); } catch (e) { out.sent_error = String(e.message || e); }
  try { out.repeats = await findRepeats(dry, q.school ? String(q.school) : ''); } catch (e) { out.repeat_error = String(e.message || e); }
  return res.status(200).json(out);
};
module.exports.repeatMessage = repeatMessage;
