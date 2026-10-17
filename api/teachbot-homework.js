// DigiSmart ERP — Homework from TeachBot's Homework Planner (Oct 2026)
// The door TeachBot uses to post a class's day of homework to parents.
// ERP's communications table is locked (no public writes), so TeachBot's server
// calls this file instead, proving who it is with a shared secret:
//   Vercel setting TEACHBOT_LINK_KEY — the SAME long random value in BOTH
//   projects (ERP and TeachBot). Without it, nothing is accepted.
// The school must exist in ERP. The row is the same shape ERP's own Homework tab
// saves, and parents get the same phone alert as for homework posted in ERP.
//
// POST  header x-teachbot-key: <TEACHBOT_LINK_KEY>
//   { school_id, type?, class_name, due_date, title, message, subject, sender_name }
//   type: 'homework' (default) or 'classwork' — "In class today", shown on the parent home page
//   → { ok: true, id, alerts: { sent, failed } }

const crypto = require('crypto');
const { sb, enc, getServiceKey, sendToSubs, logOnce, pushReady } = require('./_push');

const BASE = 'https://erp.digismartschool.com';
// TeachBot class names → ERP class names (ERP writes Pre KG as "PreKG")
const CLASS_MAP = { 'Pre KG': 'PreKG', 'PRE KG': 'PreKG', 'Pre-KG': 'PreKG' };

function str(v, n) { return String(v == null ? '' : v).trim().slice(0, n); }
function short(t, n) { t = String(t || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; }
function keyOk(given) {
  const want = process.env.TEACHBOT_LINK_KEY || '';
  if (!want || !given) return false;
  const a = Buffer.from(String(given)), b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Phones of parents whose child is in this class (same as push.js subsForClass)
async function subsForClass(schoolId, cls) {
  const subs = await sb('GET', 'push_subscriptions?school_id=eq.' + enc(schoolId) + '&select=id,student_id,endpoint,p256dh,auth') || [];
  if (!subs.length) return [];
  const stu = await sb('GET', 'students?school_id=eq.' + enc(schoolId) + '&status=eq.active&class=eq.' + enc(cls) + '&select=id') || [];
  const ids = new Set(stu.map(s => String(s.id)));
  return subs.filter(s => ids.has(String(s.student_id)));
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
  const rawCls = str(body.class_name, 30);
  const cls = CLASS_MAP[rawCls] || rawCls;
  const due = str(body.due_date, 10);
  const message = str(body.message, 4000);
  const type = body.type === 'classwork' ? 'classwork' : 'homework';
  if (!schoolId || !/^[a-zA-Z0-9_-]+$/.test(schoolId)) return res.status(400).json({ ok: false, error: 'ERP school id missing.' });
  if (!cls) return res.status(400).json({ ok: false, error: 'Class missing.' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) return res.status(400).json({ ok: false, error: 'Date missing.' });
  if (!message) return res.status(400).json({ ok: false, error: 'Homework text missing.' });

  try {
    const sch = await sb('GET', 'schools?id=eq.' + enc(schoolId) + '&select=id&limit=1') || [];
    if (!sch.length) return res.status(404).json({ ok: false, error: 'School ' + schoolId + ' not found in ERP. Check erp_school_id in TeachBot.' });

    const rows = await sb('POST', 'communications', [{
      school_id: schoolId, type: type,
      title: str(body.title, 200) || (cls + ' Homework'),
      message,
      subject: str(body.subject, 300),
      target_class: cls, target_section: null,
      due_date: due, priority: 'normal',
      sender_name: str(body.sender_name, 120) || 'School',
      created_at: new Date().toISOString()
    }]) || [];
    const c = rows[0] || {};

    // Phone alert to this class's parents, once (same wording as ERP's own homework)
    let alerts = { sent: 0, failed: 0, skipped: 'no phone alerts set up' };
    if (pushReady() && c.id && await logOnce(schoolId, 'comm', String(c.id))) {
      const subs = await subsForClass(schoolId, cls);
      // Parents with more than one child: say which child, and open on that child
      const names = {};
      const ids = [...new Set(subs.map(s => String(s.student_id)))];
      for (let i = 0; i < ids.length; i += 80) {
        try {
          const rows = await sb('GET', 'students?id=in.(' + ids.slice(i, i + 80).map(enc).join(',') + ')&select=id,full_name') || [];
          rows.forEach(r => { const n = String(r.full_name || '').trim().split(/\s+/)[0]; if (n) names[String(r.id)] = n; });
        } catch (e) { /* alert still goes, just without the name */ }
      }
      alerts = await sendToSubs(subs, s => {
        const who = names[String(s.student_id)];
        return {
          title: (type === 'classwork' ? '📖 In class today' : '📚 Homework') + (who ? ' · ' + who : '') + ': ' + short(c.title, 60),
          body: short(c.message, 140),
          tag: 'comm-' + c.id + '-' + s.student_id,
          url: BASE + '/parent/dashboard.html?child=' + enc(s.student_id)
        };
      }, false);
    }
    return res.status(200).json({ ok: true, id: c.id || null, alerts });
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'ERP could not save the homework: ' + String(e.message || e).slice(0, 200) });
  }
};
