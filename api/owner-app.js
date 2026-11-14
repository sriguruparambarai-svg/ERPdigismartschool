// DigiSmart ERP — Owner App API (Nov 2026)
// The school owner's own phone app (/owner/). Whatever the ERP does on
// autopilot, the owner is told here, so nothing is missed.
//
// POST { action: 'login', email, password }          → 30-day owner app pass
// POST { action: 'public_key' }                      → key the phone needs to accept alerts
// POST { token, action: 'subscribe', subscription }  → this phone gets the owner's alerts
// POST { token, action: 'unsubscribe', endpoint }
// POST { token, action: 'status', endpoint }         → are alerts on for this phone?
// POST { token, action: 'alerts' }                   → the inbox (last 60 alerts)
// The list behind a fee-reminder alert comes from /api/fee-reminders (action 'history').

const crypto = require('crypto');
const { sb, enc, getServiceKey } = require('./_push');
const ownerLogin = require('./owner-login');

const DAYS_30 = 30 * 24 * 60 * 60 * 1000;

function sign(payloadObj) {
  const payload = JSON.stringify(payloadObj);
  const sig = crypto.createHmac('sha256', getServiceKey()).update(payload).digest('hex');
  return Buffer.from(payload).toString('base64') + '.' + sig;
}
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

// Runs the ERP's own owner login (same password check, same suspended/demo rules)
function checkOwnerPassword(email, password) {
  return new Promise(resolve => {
    const fakeRes = {
      _code: 200,
      status(c) { this._code = c; return this; },
      json(obj) { resolve({ code: this._code, body: obj }); return this; }
    };
    Promise.resolve(ownerLogin({ method: 'POST', body: { email, password }, headers: {} }, fakeRes))
      .catch(() => resolve({ code: 500, body: { ok: false, error: 'Login failed. Please try again.' } }));
  });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  if (!getServiceKey()) return res.status(500).json({ ok: false, error: 'Server key not configured.' });

  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); }
  catch (e) { return res.status(400).json({ ok: false, error: 'Invalid request.' }); }
  const action = String(body.action || '');

  try {
    if (action === 'login') {
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      if (!email || !password) return res.status(400).json({ ok: false, error: 'Please type your email and password.' });
      const r = await checkOwnerPassword(email, password);
      if (r.code === 404) return res.status(401).json({ ok: false, error: 'This app is only for the school owner. Use the owner (school) email.' });
      if (!r.body || !r.body.ok) return res.status(r.code || 401).json({ ok: false, error: (r.body && r.body.error) || 'Login failed.' });
      const school = r.body.school || {};
      // The owner stays logged in on this phone for 30 days
      const token = sign({ sid: school.school_id, role: 'owner_app', mods: [], exp: Date.now() + DAYS_30 });
      return res.status(200).json({ ok: true, token, school: { school_id: school.school_id, name: school.name } });
    }

    if (action === 'public_key') {
      if (!process.env.VAPID_PUBLIC_KEY) return res.status(200).json({ ok: false, error: 'Alerts are not set up yet.' });
      return res.status(200).json({ ok: true, key: process.env.VAPID_PUBLIC_KEY });
    }

    const session = verifyToken(body.token);
    if (!session || !session.sid || session.role !== 'owner_app') {
      return res.status(401).json({ ok: false, error: 'Please log in again.' });
    }
    const schoolId = String(session.sid);

    if (action === 'subscribe') {
      const s = body.subscription || {};
      const keys = s.keys || {};
      if (!/^https:\/\//.test(s.endpoint || '') || !keys.p256dh || !keys.auth) {
        return res.status(400).json({ ok: false, error: 'Invalid subscription.' });
      }
      await sb('POST', 'owner_push_subscriptions?on_conflict=school_id,endpoint', [{
        school_id: schoolId, endpoint: s.endpoint, p256dh: keys.p256dh, auth: keys.auth,
        updated_at: new Date().toISOString()
      }], 'return=minimal,resolution=merge-duplicates');
      return res.status(200).json({ ok: true });
    }

    if (action === 'unsubscribe' || action === 'status') {
      const endpoint = String(body.endpoint || '');
      if (!endpoint) return res.status(200).json({ ok: true, on: false });
      const path = 'owner_push_subscriptions?school_id=eq.' + enc(schoolId) + '&endpoint=eq.' + enc(endpoint);
      if (action === 'unsubscribe') {
        await sb('DELETE', path, null, 'return=minimal');
        return res.status(200).json({ ok: true });
      }
      const rows = await sb('GET', path + '&select=id') || [];
      return res.status(200).json({ ok: true, on: rows.length > 0 });
    }

    if (action === 'alerts') {
      const rows = await sb('GET', 'owner_alerts?school_id=eq.' + enc(schoolId) +
        '&select=id,kind,alert_date,title,body,data,created_at&order=alert_date.desc,created_at.desc&limit=60') || [];
      let name = '';
      try {
        const sch = await sb('GET', 'schools?school_id=eq.' + enc(schoolId) + '&select=name&limit=1') || [];
        name = (sch[0] && sch[0].name) || '';
      } catch (e) {}
      let reminders = null;
      try {
        const fs = await sb('GET', 'fee_settings?school_id=eq.' + enc(schoolId) + '&select=auto_reminders&limit=1') || [];
        let c = fs[0] && fs[0].auto_reminders;
        if (typeof c === 'string') c = JSON.parse(c);
        reminders = !!(c && c.on);
      } catch (e) {}
      return res.status(200).json({ ok: true, school_name: name, fee_reminders_on: reminders, alerts: rows });
    }

    return res.status(400).json({ ok: false, error: 'Unknown action.' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};
