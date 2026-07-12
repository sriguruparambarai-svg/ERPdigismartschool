// DigiSmart ERP — Owner Login API (Database Lockdown Phase 1)
// Checks the school owner's password on the SERVER, so password
// hashes never travel to any browser. POST { email, password }
//
// Returns 404 if the email is not an owner account (the login page
// then tries staff login), 401 for wrong password, 403 for
// suspended/expired accounts, 200 with school info on success.

const crypto = require('crypto');

const SUPABASE_URL = 'https://nkfxrbumhjztmdyepygt.supabase.co';
const ANON_KEY = 'sb_publishable_7RgXFcDeOipMGoFuPI7XBQ_r_aJpZdL'; // public key, same as config.js

function getServiceKey() {
  return process.env.SUPABASE_SERVICE_KEY
      || process.env.SUPABASE_SERVICE_ROLE_KEY
      || '';
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

async function sb(method, path, bodyObj) {
  const key = getServiceKey();
  const opts = {
    method,
    headers: {
      apikey: key,
      Authorization: 'Bearer ' + key,
      'Content-Type': 'application/json'
    }
  };
  if (bodyObj) opts.body = JSON.stringify(bodyObj);
  const r = await fetch(SUPABASE_URL + '/rest/v1/' + path, opts);
  if (!r.ok && method === 'GET') throw new Error('Database error (' + r.status + ')');
  const text = await r.text();
  try { return text ? JSON.parse(text) : null; } catch (e) { return null; }
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

    // 1. Find the school by owner email
    const schools = await sb('GET', 'schools?email=eq.' + encodeURIComponent(email) +
      '&select=school_id,school_code,name,email,subscription_status,status,demo_expires&limit=1');
    if (!schools || schools.length === 0) {
      // Not an owner — login page will try staff login next
      return res.status(404).json({ ok: false, error: 'not_owner' });
    }
    const school = schools[0];

    // 2. Check password — protected owner_credentials table first,
    //    Supabase Auth as fallback for accounts without a stored hash
    let passwordOk = false;
    const creds = await sb('GET', 'owner_credentials?school_id=eq.' + encodeURIComponent(school.school_id) +
      '&select=password_hash&limit=1');
    if (creds && creds.length > 0 && creds[0].password_hash) {
      passwordOk = creds[0].password_hash === sha256(password);
    } else {
      const authRes = await fetch(SUPABASE_URL + '/auth/v1/token?grant_type=password', {
        method: 'POST',
        headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email, password: password })
      });
      passwordOk = authRes.ok;
    }

    if (!passwordOk) {
      return res.status(401).json({ ok: false, error: 'Incorrect password. Please try again or contact support.' });
    }

    // 3. Check school is active
    const schoolStatus = school.subscription_status || school.status;
    if (schoolStatus === 'suspended') {
      return res.status(403).json({ ok: false, error: 'Your school account is suspended. Please contact DigiSmart ERP support.' });
    }

    // 4. Check demo expiry (auto-suspend if expired — same behaviour as before)
    if (schoolStatus === 'demo' && school.demo_expires) {
      const today = new Date().toISOString().split('T')[0];
      if (school.demo_expires < today) {
        await sb('PATCH', 'schools?school_code=eq.' + encodeURIComponent(school.school_code),
          { subscription_status: 'suspended' });
        return res.status(403).json({ ok: false, error: 'Your demo period has ended. Please contact DigiSmart ERP to purchase a plan.' });
      }
    }

    // 5. Success
    return res.status(200).json({
      ok: true,
      school: {
        school_id: school.school_id,
        school_code: school.school_code,
        name: school.name,
        email: school.email
      }
    });

  } catch (err) {
    console.error('owner-login error:', err);
    return res.status(500).json({ ok: false, error: 'Login failed. Please try again in a moment.' });
  }
};
