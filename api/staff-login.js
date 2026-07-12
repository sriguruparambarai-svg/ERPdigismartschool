// DigiSmart ERP — Staff Login API
// Checks staff email + password on the SERVER (service key).
// The browser never touches the staff_users table, so password
// hashes are never exposed. POST { email, password }

const crypto = require('crypto');

const SUPABASE_URL = 'https://nkfxrbumhjztmdyepygt.supabase.co';

function getServiceKey() {
  return process.env.SUPABASE_SERVICE_KEY
      || process.env.SUPABASE_SERVICE_ROLE_KEY
      || '';
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

// ── Signed session token (Lockdown Phase 2) ──
function makeSessionToken(schoolId, role, modules) {
  const payload = JSON.stringify({
    sid: schoolId,
    role: role,
    mods: modules || [],
    exp: Date.now() + 12 * 60 * 60 * 1000
  });
  const sig = crypto.createHmac('sha256', getServiceKey()).update(payload).digest('hex');
  return Buffer.from(payload).toString('base64') + '.' + sig;
}

// Small helper: talk to Supabase REST with the service key
async function sbGet(path) {
  const key = getServiceKey();
  const r = await fetch(SUPABASE_URL + '/rest/v1/' + path, {
    headers: { apikey: key, Authorization: 'Bearer ' + key }
  });
  if (!r.ok) throw new Error('Database error (' + r.status + ')');
  return r.json();
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'POST only' });
  }
  if (!getServiceKey()) {
    return res.status(500).json({ ok: false, error: 'Server key not configured.' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');

    if (!email || !password) {
      return res.status(400).json({ ok: false, error: 'Email and password are required.' });
    }

    // 1. Find staff user by email
    const rows = await sbGet('staff_users?email=eq.' + encodeURIComponent(email) + '&select=*&limit=1');
    if (!rows || rows.length === 0) {
      return res.status(401).json({ ok: false, error: 'Incorrect email or password.' });
    }
    const staff = rows[0];

    // 2. Check password (same SHA-256 style as owner login)
    if (staff.password_hash !== sha256(password)) {
      return res.status(401).json({ ok: false, error: 'Incorrect email or password.' });
    }

    // 3. Check staff account is active
    if (staff.is_active === false) {
      return res.status(403).json({ ok: false, error: 'This staff account has been deactivated. Please contact your school admin.' });
    }

    // 4. Check the parent school is not suspended
    const schools = await sbGet('schools?school_id=eq.' + encodeURIComponent(staff.school_id) + '&select=name,school_id,school_code,subscription_status,status&limit=1');
    if (!schools || schools.length === 0) {
      return res.status(403).json({ ok: false, error: 'School account not found. Please contact DigiSmart ERP support.' });
    }
    const school = schools[0];
    const schoolStatus = school.subscription_status || school.status;
    if (schoolStatus === 'suspended') {
      return res.status(403).json({ ok: false, error: 'Your school account is suspended. Please contact DigiSmart ERP support.' });
    }

    // 5. Success — send back identity + allowed modules (never the password hash)
    return res.status(200).json({
      ok: true,
      session_token: makeSessionToken(staff.school_id, 'staff', staff.allowed_modules || []),
      staff: {
        staff_name: staff.staff_name,
        email: staff.email,
        school_id: staff.school_id,
        school_code: staff.school_code || school.school_code,
        school_name: school.name,
        allowed_modules: staff.allowed_modules || []
      }
    });

  } catch (err) {
    console.error('staff-login error:', err);
    return res.status(500).json({ ok: false, error: 'Login failed. Please try again in a moment.' });
  }
};
