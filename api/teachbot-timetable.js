// DigiSmart ERP — Master timetable for TeachBot (Oct 2026)
// The door TeachBot's server uses to READ a school's master timetable, so the
// Term Planner can place lessons on the class's real periods and put TeachBot
// lessons only on the periods the class goes to the AI class room.
// Read only — nothing is changed here.
// Proved with the same shared secret as teachbot-homework.js:
//   Vercel setting TEACHBOT_LINK_KEY — the SAME value in BOTH projects.
//
// POST  header x-teachbot-key: <TEACHBOT_LINK_KEY>
//   { school_id, academic_year? }   (no year → the most recently saved master)
//   → { ok: true, academic_year, classes, grid, periods, working_days, ai_class, updated_at }
//     grid: { Monday: { "0": { "Class 1": { subject, teacher, ai?, common? } } } }
//     periods: [{ label, start, end, isBreak }]   (index = the grid's period number)
//   { school_id, which:'staff' }   (Oct 2026) → the copy last SENT to staff (Send to staff button),
//     same shape plus staff_sent_at; grid null when never sent. Used by TeachBot's staff app.

const crypto = require('crypto');

const SUPABASE_URL = 'https://nkfxrbumhjztmdyepygt.supabase.co';

function getServiceKey() {
  return process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
}
function str(v, n) { return String(v == null ? '' : v).trim().slice(0, n); }
function keyOk(given) {
  const want = process.env.TEACHBOT_LINK_KEY || '';
  if (!want || !given) return false;
  const a = Buffer.from(String(given)), b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
async function sb(path) {
  const key = getServiceKey();
  const r = await fetch(SUPABASE_URL + '/rest/v1/' + path, { headers: { apikey: key, Authorization: 'Bearer ' + key } });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
  if (!r.ok) throw new Error((data && data.message) || ('Database error ' + r.status));
  return data || [];
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  if (!getServiceKey()) return res.status(500).json({ ok: false, error: 'ERP server key not configured.' });
  if (!process.env.TEACHBOT_LINK_KEY) return res.status(500).json({ ok: false, error: 'TEACHBOT_LINK_KEY is not set in ERP\'s Vercel settings.' });
  if (!keyOk(req.headers['x-teachbot-key'])) return res.status(401).json({ ok: false, error: 'TeachBot link key is missing or does not match ERP\'s TEACHBOT_LINK_KEY.' });

  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); }
  catch (e) { return res.status(400).json({ ok: false, error: 'Invalid request.' }); }

  const schoolId = str(body.school_id, 64);
  if (!schoolId || !/^[a-zA-Z0-9_-]+$/.test(schoolId)) return res.status(400).json({ ok: false, error: 'ERP school id missing.' });
  const year = str(body.academic_year, 12);
  const enc = encodeURIComponent;

  try {
    if (body.which === 'staff') {
      const [rows, st] = await Promise.all([
        sb('tt_master?school_id=eq.' + enc(schoolId) + (year ? '&academic_year=eq.' + enc(year) : '') +
           '&staff_sent_at=not.is.null&select=academic_year,staff_classes,staff_grid,staff_sent_at&order=staff_sent_at.desc&limit=1'),
        sb('tt_settings?school_id=eq.' + enc(schoolId) + '&select=periods,working_days,ai_class&limit=1')
      ]);
      const r = rows[0], s0 = st[0] || {};
      return res.status(200).json({ ok: true, academic_year: r ? r.academic_year : '', classes: (r && r.staff_classes) || [],
        grid: r ? (r.staff_grid || {}) : null, staff_sent_at: r ? r.staff_sent_at : null,
        periods: s0.periods || [], working_days: s0.working_days || [], ai_class: !!s0.ai_class,
        note: r ? '' : 'The timetable has not been sent to staff yet.' });
    }
    const mq = 'tt_master?school_id=eq.' + enc(schoolId) + (year ? '&academic_year=eq.' + enc(year) : '') +
               '&select=academic_year,classes,grid,updated_at&order=updated_at.desc&limit=1';
    const [mrows, srows] = await Promise.all([
      sb(mq),
      sb('tt_settings?school_id=eq.' + enc(schoolId) + '&select=periods,working_days,ai_class&limit=1')
    ]);
    const m = mrows[0];
    if (!m) return res.status(200).json({ ok: true, academic_year: year || '', classes: [], grid: null,
      periods: (srows[0] && srows[0].periods) || [], working_days: (srows[0] && srows[0].working_days) || [],
      ai_class: !!(srows[0] && srows[0].ai_class), note: 'No master timetable saved in ERP yet.' });
    const s = srows[0] || {};
    return res.status(200).json({ ok: true, academic_year: m.academic_year, classes: m.classes || [], grid: m.grid || {},
      periods: s.periods || [], working_days: s.working_days || [], ai_class: !!s.ai_class, updated_at: m.updated_at || null });
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'Could not read the timetable. ' + String(e.message || e).slice(0, 200) });
  }
};
