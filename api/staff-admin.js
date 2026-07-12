// DigiSmart ERP — Staff Admin API (owner only)
// Used by pages/staff-logins.html to manage staff accounts.
// Every action happens on the SERVER with the service key.
//
// Actions (POST { action, ... }):
//   owner_verify   { email, password }                          → returns admin token
//   list_staff     { token, school_id }                         → list staff (no hashes)
//   create_staff   { token, school_id, school_code, staff_name, email, password, allowed_modules }
//   update_staff   { token, school_id, id, staff_name, allowed_modules }
//   reset_password { token, school_id, id, password }
//   set_active     { token, school_id, id, is_active }
//   delete_staff   { token, school_id, id }

const crypto = require('crypto');

const SUPABASE_URL = 'https://nkfxrbumhjztmdyepygt.supabase.co';
const ANON_KEY = 'sb_publishable_7RgXFcDeOipMGoFuPI7XBQ_r_aJpZdL'; // public key, same as config.js
const TOKEN_HOURS = 4; // owner token validity

function getServiceKey() {
  return process.env.SUPABASE_SERVICE_KEY
      || process.env.SUPABASE_SERVICE_ROLE_KEY
      || '';
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function hmac(text) {
  return crypto.createHmac('sha256', getServiceKey()).update(text).digest('hex');
}

// ── Owner token: proves "the school owner verified their password" ──
function makeToken(schoolId) {
  const expires = Date.now() + TOKEN_HOURS * 60 * 60 * 1000;
  const payload = schoolId + '|' + expires;
  return Buffer.from(payload).toString('base64') + '.' + hmac(payload);
}

function checkToken(token, schoolId) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 2) return false;
    const payload = Buffer.from(parts[0], 'base64').toString('utf8');
    if (hmac(payload) !== parts[1]) return false;               // signature must match
    const seg = payload.split('|');
    if (seg[0] !== String(schoolId)) return false;              // token is for this school only
    if (Date.now() > parseInt(seg[1], 10)) return false;        // not expired
    return true;
  } catch (e) { return false; }
}

// ── Supabase REST helpers (service key) ──
async function sb(method, path, bodyObj) {
  const key = getServiceKey();
  const opts = {
    method,
    headers: {
      apikey: key,
      Authorization: 'Bearer ' + key,
      'Content-Type': 'application/json',
      Prefer: 'return=representation'
    }
  };
  if (bodyObj) opts.body = JSON.stringify(bodyObj);
  const r = await fetch(SUPABASE_URL + '/rest/v1/' + path, opts);
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
  if (!r.ok) {
    const msg = (data && (data.message || data.details)) || ('Database error ' + r.status);
    const err = new Error(msg);
    err.status = r.status;
    throw err;
  }
  return data;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'POST only' });
  }
  if (!getServiceKey()) {
    return res.status(500).json({ ok: false, error: 'Server key not configured.' });
  }

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  } catch (e) {
    return res.status(400).json({ ok: false, error: 'Invalid request.' });
  }

  const action = body.action;

  try {
    // ══ 1. OWNER VERIFY — owner re-enters password, receives a token ══
    if (action === 'owner_verify') {
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      if (!email || !password) {
        return res.status(400).json({ ok: false, error: 'Email and password are required.' });
      }

      const schools = await sb('GET', 'schools?email=eq.' + encodeURIComponent(email) + '&select=school_id,school_code,name,password_hash,subscription_status,status&limit=1');
      if (!schools || schools.length === 0) {
        return res.status(401).json({ ok: false, error: 'Owner account not found.' });
      }
      const school = schools[0];

      let passwordOk = false;
      if (school.password_hash) {
        // Password stored in schools table (hashed)
        passwordOk = school.password_hash === sha256(password);
      } else {
        // Older accounts: password lives in Supabase Auth — verify there
        const authRes = await fetch(SUPABASE_URL + '/auth/v1/token?grant_type=password', {
          method: 'POST',
          headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password })
        });
        passwordOk = authRes.ok;
      }

      if (!passwordOk) {
        return res.status(401).json({ ok: false, error: 'Incorrect password.' });
      }

      return res.status(200).json({
        ok: true,
        token: makeToken(school.school_id),
        school_id: school.school_id,
        school_code: school.school_code,
        school_name: school.name
      });
    }

    // ══ All actions below need a valid owner token ══
    const schoolId = String(body.school_id || '');
    if (!checkToken(body.token, schoolId)) {
      return res.status(401).json({ ok: false, error: 'Session expired. Please verify your password again.' });
    }

    // ══ 2. LIST STAFF ══
    if (action === 'list_staff') {
      const rows = await sb('GET', 'staff_users?school_id=eq.' + encodeURIComponent(schoolId) +
        '&select=id,staff_name,email,allowed_modules,is_active,created_at&order=created_at.asc');
      return res.status(200).json({ ok: true, staff: rows || [] });
    }

    // ══ 3. CREATE STAFF ══
    if (action === 'create_staff') {
      const staffName = String(body.staff_name || '').trim();
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      const modules = Array.isArray(body.allowed_modules) ? body.allowed_modules : [];

      if (!staffName || !email || !password) {
        return res.status(400).json({ ok: false, error: 'Name, email and password are required.' });
      }
      if (password.length < 6) {
        return res.status(400).json({ ok: false, error: 'Password must be at least 6 characters.' });
      }
      if (modules.length === 0) {
        return res.status(400).json({ ok: false, error: 'Please tick at least one module for this staff member.' });
      }

      // Email must not clash with a school owner login
      const ownerClash = await sb('GET', 'schools?email=eq.' + encodeURIComponent(email) + '&select=school_id&limit=1');
      if (ownerClash && ownerClash.length > 0) {
        return res.status(409).json({ ok: false, error: 'This email is already used by a school owner account. Please use a different email.' });
      }

      try {
        const inserted = await sb('POST', 'staff_users', [{
          school_id: schoolId,
          school_code: body.school_code || schoolId,
          staff_name: staffName,
          email: email,
          password_hash: sha256(password),
          allowed_modules: modules,
          is_active: true
        }]);
        return res.status(200).json({ ok: true, staff: inserted && inserted[0] ? {
          id: inserted[0].id, staff_name: inserted[0].staff_name, email: inserted[0].email,
          allowed_modules: inserted[0].allowed_modules, is_active: inserted[0].is_active
        } : null });
      } catch (e) {
        if (e.status === 409 || /duplicate/i.test(e.message)) {
          return res.status(409).json({ ok: false, error: 'A staff login with this email already exists.' });
        }
        throw e;
      }
    }

    // ══ Actions on one existing staff row — must belong to this school ══
    const staffId = String(body.id || '');
    if (['update_staff', 'reset_password', 'set_active', 'delete_staff'].includes(action)) {
      if (!staffId) return res.status(400).json({ ok: false, error: 'Staff id is required.' });
      const check = await sb('GET', 'staff_users?id=eq.' + encodeURIComponent(staffId) +
        '&school_id=eq.' + encodeURIComponent(schoolId) + '&select=id&limit=1');
      if (!check || check.length === 0) {
        return res.status(404).json({ ok: false, error: 'Staff member not found for this school.' });
      }
    }

    // ══ 4. UPDATE STAFF (name / modules) ══
    if (action === 'update_staff') {
      const patch = { updated_at: new Date().toISOString() };
      if (body.staff_name) patch.staff_name = String(body.staff_name).trim();
      if (Array.isArray(body.allowed_modules)) {
        if (body.allowed_modules.length === 0) {
          return res.status(400).json({ ok: false, error: 'Please tick at least one module.' });
        }
        patch.allowed_modules = body.allowed_modules;
      }
      await sb('PATCH', 'staff_users?id=eq.' + encodeURIComponent(staffId), patch);
      return res.status(200).json({ ok: true });
    }

    // ══ 5. RESET PASSWORD ══
    if (action === 'reset_password') {
      const password = String(body.password || '');
      if (password.length < 6) {
        return res.status(400).json({ ok: false, error: 'Password must be at least 6 characters.' });
      }
      await sb('PATCH', 'staff_users?id=eq.' + encodeURIComponent(staffId), {
        password_hash: sha256(password), updated_at: new Date().toISOString()
      });
      return res.status(200).json({ ok: true });
    }

    // ══ 6. ACTIVATE / DEACTIVATE ══
    if (action === 'set_active') {
      await sb('PATCH', 'staff_users?id=eq.' + encodeURIComponent(staffId), {
        is_active: body.is_active === true, updated_at: new Date().toISOString()
      });
      return res.status(200).json({ ok: true });
    }

    // ══ 7. DELETE STAFF ══
    if (action === 'delete_staff') {
      await sb('DELETE', 'staff_users?id=eq.' + encodeURIComponent(staffId));
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ ok: false, error: 'Unknown action.' });

  } catch (err) {
    console.error('staff-admin error:', err);
    return res.status(500).json({ ok: false, error: 'Something went wrong. Please try again.' });
  }
};
