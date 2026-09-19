// DigiSmart ERP — Morning Job
// The second door Vercel's scheduler knocks on, early in the morning.
// Right now it does one thing: today's birthday wishes.
//
// The evening job (api/daily-job.js) is unchanged — the foundation question
// and the album tidy-up still run there at 7pm. Birthday wishes need the
// morning, so they live here.
//
// Vercel sends a GET with "Authorization: Bearer <CRON_SECRET>". Nothing else
// gets in. Birthdays are wished every day, Sundays and holidays included.

const BASE = 'https://erp.digismartschool.com';

module.exports = async (req, res) => {
  const secret = process.env.CRON_SECRET || '';
  if (!secret) {
    return res.status(500).json({ ok: false, error: 'CRON_SECRET not configured.' });
  }

  // The scheduler sends the secret in the header. A query parameter works too,
  // so it can be triggered by hand for a test.
  const header = String(req.headers.authorization || '');
  const fromHeader = header === 'Bearer ' + secret;
  const fromQuery = req.query && String(req.query.key || '') === secret;
  if (!fromHeader && !fromQuery) {
    return res.status(401).json({ ok: false, error: 'Not allowed.' });
  }

  const out = { ok: true, ran_at: new Date().toISOString() };

  try {
    const r = await fetch(BASE + '/api/push?job=birthday&cron_secret=' + encodeURIComponent(secret));
    out.birthdays = await r.json();
  } catch (e) {
    out.birthdays = { ok: false, error: String(e.message || e) };
  }

  return res.status(200).json(out);
};
