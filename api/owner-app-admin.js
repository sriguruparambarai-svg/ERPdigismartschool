// DigiSmart ERP — Owner App people, for the DigiSmart SUPER ADMIN only (Nov 2026)
// Used by pages/owner-app-admin.html. Not reachable with any school login —
// the office (even with the ERP owner email) can never add themselves or reset an owner.
// Guarded by the super admin key: Vercel setting SUPER_ADMIN_KEY (or CRON_SECRET if that is not set).
//
// POST { key, action: 'schools' }                         → every school (id + name)
// POST { key, action: 'list', school_id }                 → that school's Owner App people (no passwords)
// POST { key, action: 'add', school_id, name, phone }     → new person + one-time starting PIN (shown once)
// POST { key, action: 'reset', id }                       → new starting PIN; their phone is warned, then logged out
// POST { key, action: 'remove', id }                      → person removed; their phone is logged out

const crypto = require('crypto');
const { sb, enc, getServiceKey, sendToSubs, pushReady } = require('./_push');
const { hashSecret } = require('./owner-app');

function adminKey() { return process.env.SUPER_ADMIN_KEY || process.env.CRON_SECRET || ''; }
function keyOk(k) {
  const want = adminKey();
  if (!want || !k) return false;
  const a = Buffer.from(String(k)), b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function cleanPhone(p) { const d = String(p || '').replace(/\D/g, ''); return d.length > 10 ? d.slice(-10) : d; }
function newPin() { return String(crypto.randomInt(100000, 1000000)); }   // 6 digits

// Phones of this person: warn them, then forget the phones (they are logged out anyway)
async function warnAndForget(user, title, bodyText) {
  const subs = await sb('GET', 'owner_push_subscriptions?user_id=eq.' + enc(user.id) + '&select=id,endpoint,p256dh,auth').catch(() => []) || [];
  if (subs.length && pushReady()) {
    try {
      await sendToSubs(subs, () => ({ title, body: bodyText, tag: 'owner-reset-' + user.id, url: 'https://erp.digismartschool.com/owner/index.html' }), true);
    } catch (e) {}
  }
  if (subs.length) { try { await sb('DELETE', 'owner_push_subscriptions?user_id=eq.' + enc(user.id), null, 'return=minimal'); } catch (e) {} }
  return subs.length;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  if (!getServiceKey()) return res.status(500).json({ ok: false, error: 'Server key not configured.' });
  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); }
  catch (e) { return res.status(400).json({ ok: false, error: 'Invalid request.' }); }
  if (!keyOk(body.key)) return res.status(401).json({ ok: false, error: 'Wrong super admin key.' });
  const action = String(body.action || '');

  try {
    if (action === 'schools') {
      const rows = await sb('GET', 'schools?select=school_id,name&order=name.asc&limit=1000') || [];
      return res.status(200).json({ ok: true, schools: rows.filter(r => r.school_id) });
    }

    if (action === 'list') {
      const sid = String(body.school_id || '');
      if (!sid) return res.status(400).json({ ok: false, error: 'Choose a school.' });
      const rows = await sb('GET', 'owner_app_users?school_id=eq.' + enc(sid) +
        '&select=id,name,phone,must_change,last_login,locked_until,created_at&order=created_at.asc') || [];
      return res.status(200).json({ ok: true, people: rows });
    }

    if (action === 'add') {
      const sid = String(body.school_id || '');
      const name = String(body.name || '').trim();
      const phone = cleanPhone(body.phone);
      if (!sid || !name) return res.status(400).json({ ok: false, error: 'Please fill the school and the name.' });
      if (phone.length !== 10) return res.status(400).json({ ok: false, error: 'Please type a 10-digit mobile number.' });
      const dup = await sb('GET', 'owner_app_users?school_id=eq.' + enc(sid) + '&phone=eq.' + enc(phone) + '&select=id&limit=1') || [];
      if (dup.length) return res.status(400).json({ ok: false, error: 'This number is already added for this school. Use Reset to give a new starting PIN.' });
      const pin = newPin();
      await sb('POST', 'owner_app_users', [{ school_id: sid, name, phone, start_pin: hashSecret(pin), must_change: true, pass_ver: 1 }], 'return=minimal');
      return res.status(200).json({ ok: true, pin, phone, name });
    }

    if (action === 'reset' || action === 'remove') {
      const id = String(body.id || '');
      const rows = await sb('GET', 'owner_app_users?id=eq.' + enc(id) + '&select=id,name,phone,pass_ver&limit=1') || [];
      const u = rows[0];
      if (!u) return res.status(404).json({ ok: false, error: 'Person not found.' });
      if (action === 'remove') {
        await warnAndForget(u, '🔒 Owner App access removed', 'Your Owner App access was removed by DigiSmart. If you did not ask for this, please contact DigiSmart at once.');
        await sb('DELETE', 'owner_app_users?id=eq.' + enc(id), null, 'return=minimal');
        return res.status(200).json({ ok: true });
      }
      // Reset: warn the phone FIRST, so the owner knows if he did not ask for it
      const warned = await warnAndForget(u, '🔒 Owner App password was reset',
        'Your Owner App password was just reset. You are logged out. If you did not ask for this, please contact DigiSmart at once.');
      const pin = newPin();
      await sb('PATCH', 'owner_app_users?id=eq.' + enc(id), {
        start_pin: hashSecret(pin), password: null, must_change: true, pass_ver: (u.pass_ver || 1) + 1,
        failed_tries: 0, locked_until: null
      }, 'return=minimal');
      return res.status(200).json({ ok: true, pin, phone: u.phone, name: u.name, phones_warned: warned });
    }

    return res.status(400).json({ ok: false, error: 'Unknown action.' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};
