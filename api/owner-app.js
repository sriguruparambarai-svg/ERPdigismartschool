// DigiSmart ERP — Owner App API (Nov 2026)
// The school owner's own phone app (/owner/). Whatever the ERP does on
// autopilot, the owner is told here, so nothing is missed.
//
// Login (Nov 2026, replaces the ERP owner email login — in many schools the
// office uses that email, so it must not open the Owner App):
//   • DigiSmart super admin adds each person (name + phone) with a one-time
//     starting PIN (api/owner-app-admin.js).
//   • First login with the starting PIN → the app makes them create their own
//     password at once; the starting PIN stops working. Nobody else can see it.
//   • 5 wrong tries → locked for 15 minutes.
//
// POST { action: 'login', phone, password }          → pass, or { must_change, setup } on first login
// POST { action: 'set_password', setup, password }    → first-login password → pass
// POST { token, action: 'change_password', old_password, password }
// POST { action: 'public_key' }                       → key the phone needs to accept alerts
// POST { token, action: 'subscribe', subscription }   → this phone gets the school's owner alerts
// POST { token, action: 'unsubscribe' | 'status', endpoint }
// POST { token, action: 'alerts' }                    → the inbox (last 60 alerts)
// POST { token, action: 'fee_history', date }         → the list behind a fee-reminder alert

const crypto = require('crypto');
const { sb, enc, getServiceKey } = require('./_push');

const DAYS_30 = 30 * 24 * 60 * 60 * 1000;
const SETUP_MINUTES = 15;
const MAX_TRIES = 5;
const LOCK_MINUTES = 15;

// ── Passwords are stored locked (scrypt + salt); nobody can read them back ──
function hashSecret(secret) {
  const salt = crypto.randomBytes(16).toString('hex');
  const h = crypto.scryptSync(String(secret), salt, 32).toString('hex');
  return 'scrypt$' + salt + '$' + h;
}
function secretMatches(secret, stored) {
  try {
    const p = String(stored || '').split('$');
    if (p.length !== 3 || p[0] !== 'scrypt') return false;
    const h = crypto.scryptSync(String(secret), p[1], 32);
    const want = Buffer.from(p[2], 'hex');
    return want.length === h.length && crypto.timingSafeEqual(want, h);
  } catch (e) { return false; }
}

function sign(payloadObj) {
  const payload = JSON.stringify(payloadObj);
  const sig = crypto.createHmac('sha256', getServiceKey()).update(payload).digest('hex');
  return Buffer.from(payload).toString('base64') + '.' + sig;
}
function verifySigned(token) {
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
function cleanPhone(p) { const d = String(p || '').replace(/\D/g, ''); return d.length > 10 ? d.slice(-10) : d; }

async function schoolName(schoolId) {
  try {
    const r = await sb('GET', 'schools?school_id=eq.' + enc(schoolId) + '&select=name&limit=1') || [];
    return (r[0] && r[0].name) || '';
  } catch (e) { return ''; }
}
async function passFor(user) {
  return {
    token: sign({ sid: user.school_id, uid: user.id, pv: user.pass_ver || 1, role: 'owner_app', exp: Date.now() + DAYS_30 }),
    school: { school_id: user.school_id, name: await schoolName(user.school_id) },
    name: user.name
  };
}
// A pass is good only while the person exists and has not been reset since
async function checkPass(token) {
  const d = verifySigned(token);
  if (!d || d.role !== 'owner_app' || !d.uid) return null;
  const rows = await sb('GET', 'owner_app_users?id=eq.' + enc(d.uid) + '&select=id,school_id,name,pass_ver,must_change&limit=1') || [];
  const u = rows[0];
  if (!u || u.must_change || (u.pass_ver || 1) !== d.pv || String(u.school_id) !== String(d.sid)) return null;
  return u;
}
function goodPassword(p) {
  p = String(p || '');
  if (p.length < 6) return 'Your password must have at least 6 letters or numbers.';
  if (/^(\d)\1+$/.test(p) || p === '123456' || p === '654321') return 'Please choose a password that is harder to guess.';
  return '';
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  if (!getServiceKey()) return res.status(500).json({ ok: false, error: 'Server key not configured.' });

  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); }
  catch (e) { return res.status(400).json({ ok: false, error: 'Invalid request.' }); }
  const action = String(body.action || '');

  try {
    // ── Log in with phone number + password (or the one-time starting PIN) ──
    if (action === 'login') {
      const phone = cleanPhone(body.phone);
      const secret = String(body.password || '');
      if (phone.length !== 10 || !secret) return res.status(400).json({ ok: false, error: 'Please type your mobile number and password.' });
      const users = await sb('GET', 'owner_app_users?phone=eq.' + enc(phone) + '&select=*') || [];
      if (!users.length) return res.status(401).json({ ok: false, error: 'This number is not added to the Owner App. Please contact DigiSmart.' });

      const now = Date.now();
      const open = users.filter(u => !(u.locked_until && new Date(u.locked_until).getTime() > now));
      if (!open.length) return res.status(429).json({ ok: false, error: 'Too many wrong tries. Please wait 15 minutes and try again.' });

      // The same number may be owner of more than one school
      const hit = open.filter(u => u.must_change ? secretMatches(secret, u.start_pin) : secretMatches(secret, u.password));
      if (!hit.length) {
        for (const u of open) {
          const tries = (u.failed_tries || 0) + 1;
          const patch = tries >= MAX_TRIES
            ? { failed_tries: 0, locked_until: new Date(now + LOCK_MINUTES * 60000).toISOString() }
            : { failed_tries: tries };
          try { await sb('PATCH', 'owner_app_users?id=eq.' + enc(u.id), patch, 'return=minimal'); } catch (e) {}
        }
        return res.status(401).json({ ok: false, error: 'Wrong password. Please check and try again.' });
      }
      const u = hit[0];
      await sb('PATCH', 'owner_app_users?id=eq.' + enc(u.id), { failed_tries: 0, locked_until: null }, 'return=minimal');

      if (u.must_change) {
        // First login: they must make their own password before anything else
        const setup = sign({ uid: u.id, pv: u.pass_ver || 1, role: 'owner_setup', exp: now + SETUP_MINUTES * 60000 });
        return res.status(200).json({ ok: true, must_change: true, setup, name: u.name });
      }
      await sb('PATCH', 'owner_app_users?id=eq.' + enc(u.id), { last_login: new Date().toISOString() }, 'return=minimal');
      return res.status(200).json(Object.assign({ ok: true }, await passFor(u)));
    }

    // ── First login: make my own password (the starting PIN stops working) ──
    if (action === 'set_password') {
      const d = verifySigned(body.setup);
      if (!d || d.role !== 'owner_setup' || !d.uid) return res.status(401).json({ ok: false, error: 'Time is up. Please log in again with the starting PIN.' });
      const bad = goodPassword(body.password);
      if (bad) return res.status(400).json({ ok: false, error: bad });
      const rows = await sb('GET', 'owner_app_users?id=eq.' + enc(d.uid) + '&select=*&limit=1') || [];
      const u = rows[0];
      if (!u || !u.must_change || (u.pass_ver || 1) !== d.pv) return res.status(401).json({ ok: false, error: 'Please log in again.' });
      const pv = (u.pass_ver || 1) + 1;
      await sb('PATCH', 'owner_app_users?id=eq.' + enc(u.id), {
        password: hashSecret(body.password), start_pin: null, must_change: false, pass_ver: pv,
        failed_tries: 0, locked_until: null, last_login: new Date().toISOString()
      }, 'return=minimal');
      u.pass_ver = pv; u.must_change = false;
      return res.status(200).json(Object.assign({ ok: true }, await passFor(u)));
    }

    if (action === 'public_key') {
      if (!process.env.VAPID_PUBLIC_KEY) return res.status(200).json({ ok: false, error: 'Alerts are not set up yet.' });
      return res.status(200).json({ ok: true, key: process.env.VAPID_PUBLIC_KEY });
    }

    // ── Everything below needs a good pass ──
    const user = await checkPass(body.token);
    if (!user) return res.status(401).json({ ok: false, error: 'Please log in again.' });
    const schoolId = String(user.school_id);

    if (action === 'change_password') {
      const rows = await sb('GET', 'owner_app_users?id=eq.' + enc(user.id) + '&select=password,pass_ver&limit=1') || [];
      if (!rows[0] || !secretMatches(String(body.old_password || ''), rows[0].password)) {
        return res.status(401).json({ ok: false, error: 'Your present password is not correct.' });
      }
      const bad = goodPassword(body.password);
      if (bad) return res.status(400).json({ ok: false, error: bad });
      const pv = (rows[0].pass_ver || 1) + 1;
      await sb('PATCH', 'owner_app_users?id=eq.' + enc(user.id), { password: hashSecret(body.password), pass_ver: pv }, 'return=minimal');
      user.pass_ver = pv;
      return res.status(200).json(Object.assign({ ok: true }, await passFor(user)));
    }

    if (action === 'subscribe') {
      const s = body.subscription || {};
      const keys = s.keys || {};
      if (!/^https:\/\//.test(s.endpoint || '') || !keys.p256dh || !keys.auth) {
        return res.status(400).json({ ok: false, error: 'Invalid subscription.' });
      }
      await sb('POST', 'owner_push_subscriptions?on_conflict=school_id,endpoint', [{
        school_id: schoolId, user_id: user.id, endpoint: s.endpoint, p256dh: keys.p256dh, auth: keys.auth,
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
      const rows = await sb('GET', path + '&select=id,user_id') || [];
      return res.status(200).json({ ok: true, on: rows.length > 0 && String(rows[0].user_id || '') === String(user.id) });
    }

    if (action === 'alerts') {
      const rows = await sb('GET', 'owner_alerts?school_id=eq.' + enc(schoolId) +
        '&select=id,kind,alert_date,title,body,data,created_at&order=alert_date.desc,created_at.desc&limit=60') || [];
      let reminders = null;
      try {
        const fs = await sb('GET', 'fee_settings?school_id=eq.' + enc(schoolId) + '&select=auto_reminders&limit=1') || [];
        let c = fs[0] && fs[0].auto_reminders;
        if (typeof c === 'string') c = JSON.parse(c);
        reminders = !!(c && c.on);
      } catch (e) {}
      return res.status(200).json({ ok: true, school_name: await schoolName(schoolId), name: user.name, fee_reminders_on: reminders, alerts: rows });
    }

    if (action === 'fee_history') {
      const day = /^\d{4}-\d{2}-\d{2}$/.test(String(body.date || '')) ? String(body.date) : new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
      const rows = await sb('GET', 'fee_auto_reminders?school_id=eq.' + enc(schoolId) + '&sent_on=eq.' + day +
        '&select=student_id,student_name,student_class,mobile,kind,lines,total,has_app,seen_at&order=student_class.asc,student_name.asc') || [];
      return res.status(200).json({ ok: true, date: day, list: rows });
    }

    return res.status(400).json({ ok: false, error: 'Unknown action.' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};

module.exports.hashSecret = hashSecret;
module.exports.secretMatches = secretMatches;
