// DigiSmart ERP — Nightly Job
// The one door Vercel's scheduler knocks on, once a day. It does two things:
//   1. sends the day's foundation question to every class that has one waiting
//   2. deletes photo albums that are past their one year
//
// Vercel sends a GET with "Authorization: Bearer <CRON_SECRET>". Nothing else
// gets in. Sundays are skipped for the question; the album tidy-up still runs.

const BASE = 'https://erp.digismartschool.com';

module.exports = async (req, res) => {
  const secret = process.env.CRON_SECRET || '';
  if (!secret) {
    return res.status(500).json({ ok: false, error: 'CRON_SECRET not configured.' });
  }

  // Vercel's scheduler sends the secret in the header. Allow a query
  // parameter too, so a person can trigger it by hand if needed.
  const header = String(req.headers.authorization || '');
  const fromHeader = header === 'Bearer ' + secret;
  const fromQuery = req.query && String(req.query.key || '') === secret;
  if (!fromHeader && !fromQuery) {
    return res.status(401).json({ ok: false, error: 'Not allowed.' });
  }

  const out = { ok: true, ran_at: new Date().toISOString() };

  // In India this runs in the evening, so the local day is what matters.
  const istNow = new Date(Date.now() + (5.5 * 60 * 60 * 1000));
  const isSunday = istNow.getUTCDay() === 0;

  // ── 1. The daily foundation question ──
  if (isSunday) {
    out.questions = { skipped: 'Sunday' };
  } else {
    try {
      const r = await fetch(BASE + '/api/parent-questions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'send_today', cron_secret: secret })
      });
      out.questions = await r.json();
    } catch (e) {
      out.questions = { ok: false, error: String(e.message || e) };
    }
  }

  // ── 2. Clear out expired photo albums ──
  try {
    const r = await fetch(BASE + '/api/gallery-data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'cleanup', cron_secret: secret })
    });
    out.gallery = await r.json();
  } catch (e) {
    out.gallery = { ok: false, error: String(e.message || e) };
  }

  return res.status(200).json(out);
};
