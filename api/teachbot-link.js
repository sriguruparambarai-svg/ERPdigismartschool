// DigiSmart ERP — door for TeachBot's server (Nov 2026). Server to server only: header x-teachbot-key
// must match TEACHBOT_LINK_KEY (the same key as teachbot-homework.js and defaulters.js use).
//   POST { action: 'corrections', school_id, from, to }
//        → the Daily Check Sheet's "Corrected Yes / No" ticks (homework_corrections), for teachers' appraisal
//   POST { action: 'owner_alert', school_id, kind: 'teacher_monthly', alert_date, title, body, data }
//        → one Owner App alert (the teachers' monthly evaluation), with a phone alert to the owner
//   POST { action: 'not_done_teachers', school_id, day, data: { day:[{name,classes}], week:[{name}], week_of, deadline, submitted } }
//        → teachers who didn't submit their day / last week's checklist not uploaded (for api/not-done.js)
// school_id is the ERP school id (or code).

const crypto = require('crypto');
const { sb, enc, getServiceKey, sendToSubs, pushReady, ownerSubs } = require('./_push');

const BASE = 'https://erp.digismartschool.com';
const KINDS = ['teacher_monthly'];

function keyOk(given) {
  const want = process.env.TEACHBOT_LINK_KEY || '';
  if (!want || !given) return false;
  const a = Buffer.from(String(given)), b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const clip = (s, n) => String(s == null ? '' : s).slice(0, n);

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  if (!getServiceKey()) return res.status(500).json({ ok: false, error: 'Server key not configured.' });
  if (!keyOk(req.headers['x-teachbot-key'])) return res.status(401).json({ ok: false, error: 'TeachBot link key does not match.' });
  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); }
  catch (e) { return res.status(400).json({ ok: false, error: 'Bad request body.' }); }
  try {
    const given = clip(body.school_id, 64);
    if (!/^[a-zA-Z0-9_-]+$/.test(given)) return res.status(400).json({ ok: false, error: 'ERP school id missing.' });
    const sch = await sb('GET', 'schools?or=(school_id.eq.' + enc(given) + ',school_code.eq.' + enc(given) + ')&select=school_id&limit=1') || [];
    if (!sch.length) return res.status(404).json({ ok: false, error: 'School not found in ERP.' });
    const schoolId = String(sch[0].school_id);

    if (body.action === 'corrections') {
      if (!isDate(body.from) || !isDate(body.to)) return res.status(400).json({ ok: false, error: 'Dates needed.' });
      let rows;
      try {
        rows = await sb('GET', 'homework_corrections?school_id=eq.' + enc(schoolId) + '&checked_on=gte.' + body.from + '&checked_on=lte.' + body.to +
          '&select=class,section,subject,teacher,hw_date,checked_on,corrected&limit=5000') || [];
      } catch (e) { return res.status(200).json({ ok: true, rows: [], note: 'step-check-sheet.sql not run yet' }); }
      // TeachBot names a section class "LKG B"; section A / none is just "LKG"
      return res.status(200).json({ ok: true, rows: rows.map(r => ({ class: r.class + (r.section && r.section !== 'A' ? ' ' + r.section : ''),
        subject: r.subject, teacher: r.teacher, hw_date: r.hw_date, checked_on: String(r.checked_on).slice(0, 10), corrected: r.corrected })) });
    }

    if (body.action === 'owner_alert') {
      if (KINDS.indexOf(body.kind) === -1 || !isDate(body.alert_date)) return res.status(400).json({ ok: false, error: 'Alert kind or date missing.' });
      const title = clip(body.title, 160), text = clip(body.body, 400);
      const ins = await sb('POST', 'owner_alerts?on_conflict=school_id,kind,alert_date', [{
        school_id: schoolId, kind: body.kind, alert_date: body.alert_date, title: title, body: text, data: body.data || null
      }], 'return=representation,resolution=ignore-duplicates').catch(() => []);
      if (!Array.isArray(ins) || !ins.length) return res.status(200).json({ ok: true, already_sent: true });
      let phones = 0;
      if (pushReady()) {
        const subs = await ownerSubs(schoolId, 'owner') || [];
        if (subs.length) {
          const out = await sendToSubs(subs, () => ({ title, body: text, tag: 'owner-' + body.kind + '-' + body.alert_date,
            url: BASE + '/owner/index.html?alert=' + body.kind + '&date=' + body.alert_date }), false);
          phones = out.sent;
        }
      }
      return res.status(200).json({ ok: true, owner_phones: phones });
    }
    // Nov 2026: TeachBot's part of the "not done yet" alerts (api/not-done.js reads it at 4:30 PM)
    if (body.action === 'not_done_teachers') {
      if (!isDate(body.day)) return res.status(400).json({ ok: false, error: 'Day missing.' });
      const d = body.data || {};
      const names = l => (Array.isArray(l) ? l : []).slice(0, 80).map(x => ({ name: clip(x && x.name, 80), classes: clip(x && x.classes, 120) })).filter(x => x.name);
      const data = { day: names(d.day), week: names(d.week), week_of: isDate(d.week_of) ? d.week_of : null, deadline: clip(d.deadline, 5), submitted: Number(d.submitted) || 0 };
      try {
        await sb('POST', 'not_done_feed?on_conflict=school_id,day,part', [{ school_id: schoolId, day: body.day, part: 'teachers', data, updated_at: new Date().toISOString() }],
          'return=minimal,resolution=merge-duplicates');
      } catch (e) { return res.status(200).json({ ok: false, error: 'Please run step-not-done.sql in ERP Supabase: ' + e.message }); }
      return res.status(200).json({ ok: true, kept: data.day.length + data.week.length });
    }
    return res.status(400).json({ ok: false, error: 'Unknown action.' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'Server error: ' + (e.message || e) });
  }
};
