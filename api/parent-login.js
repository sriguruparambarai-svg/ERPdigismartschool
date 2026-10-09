// DigiSmart ERP — Parent Login API (Parent Portal 2.0)
// Verifies the parent's password on the SERVER. Passwords are stored
// hashed; the browser never sees hashes, other children's data, or DOBs.
// A parent logs in with the PIN the school gave them, or the password they
// chose later. The child's date of birth works ONLY until the school makes a
// PIN for that child (so nobody is locked out during the change-over).
// 5 wrong tries lock that child's login for 15 minutes.
// POST { roll_no, password, school_id? }
// (admission_no is still accepted for older saved links)

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

function makeParentToken(schoolId, studentId) {
  const payload = JSON.stringify({
    sid: schoolId,
    stu: studentId,
    role: 'parent',
    exp: Date.now() + 30 * 24 * 60 * 60 * 1000   // parents stay logged in on their phone for 30 days
  });
  const sig = crypto.createHmac('sha256', getServiceKey()).update(payload).digest('hex');
  return Buffer.from(payload).toString('base64') + '.' + sig;
}

// Accept DOB defaults: 15042012 (DDMMYYYY) or 20120415 (YYYYMMDD)
function dobMatches(dob, pw) {
  if (!dob) return false;
  const clean = String(dob).split('T')[0];         // YYYY-MM-DD
  const parts = clean.split('-');
  if (parts.length !== 3) return false;
  const ymd = parts[0] + parts[1] + parts[2];       // YYYYMMDD
  const dmy = parts[2] + parts[1] + parts[0];       // DDMMYYYY
  return pw === dmy || pw === ymd;
}

// Same scrambling as api/student-data.js, where the office makes PINs
function pinHash(studentId, pin) {
  return crypto.createHmac('sha256', getServiceKey()).update('parent-pin:' + studentId + ':' + String(pin)).digest('hex');
}
function sameHash(a, b) {
  const x = Buffer.from(String(a || ''), 'utf8'), y = Buffer.from(String(b || ''), 'utf8');
  return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
}
async function sbPatch(path, obj) {
  const key = getServiceKey();
  try {
    await fetch(SUPABASE_URL + '/rest/v1/' + path, {
      method: 'PATCH',
      headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify(obj)
    });
  } catch (e) {}
}

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

    // ── Before login: which school is this link for? Only id and name are given out. ──
    if (body.action === 'school_lookup') {
      const alias = String(body.alias || '').trim().toLowerCase();
      const sid = String(body.school_id || '').trim();
      let rows = [];
      if (alias && /^[a-z0-9_-]{1,40}$/.test(alias)) {
        rows = await sbGet('schools?portal_alias=ilike.' + encodeURIComponent(alias) + '&select=school_id,name&limit=1');
      } else if (sid && /^[A-Za-z0-9_-]{1,64}$/.test(sid)) {
        rows = await sbGet('schools?school_id=eq.' + encodeURIComponent(sid) + '&select=school_id,name&limit=1');
      }
      const s = rows && rows[0];
      return res.status(200).json(s ? { ok: true, school_id: s.school_id, name: s.name } : { ok: false });
    }

    const loginId = String(body.roll_no || body.admission_no || '').trim().toUpperCase();
    const password = String(body.password || '');
    const schoolId = String(body.school_id || '').trim();

    if (!loginId || !password) {
      return res.status(400).json({ ok: false, error: 'Please enter roll number and password.' });
    }

    // 1. Find the student — by roll number first, then admission number
    const BASE_SELECT = '&select=id,full_name,class,section,school_id,roll_no,admission_no,parent_password_hash,dob,status';
    const PIN_SELECT = BASE_SELECT + ',parent_pin_hash,pin_fails,pin_lock_until';
    const scope = schoolId ? '&school_id=eq.' + encodeURIComponent(schoolId) : '';
    let hasPinColumns = true;
    async function find(field) {
      if (hasPinColumns) {
        try { return await sbGet('students?' + field + '=eq.' + encodeURIComponent(loginId) + PIN_SELECT + scope); }
        catch (e) { hasPinColumns = false; }   // PIN setup SQL not run yet: work the old way
      }
      return sbGet('students?' + field + '=eq.' + encodeURIComponent(loginId) + BASE_SELECT + scope);
    }

    let students = await find('roll_no');

    // Fall back to admission number so older logins keep working
    if (!students || students.length === 0) {
      students = await find('admission_no');
    }

    if (!students || students.length === 0) {
      return res.status(401).json({ ok: false, error: 'Roll number not found. Please check and try again.' });
    }
    if (students.length > 1) {
      return res.status(400).json({ ok: false, error: 'Please open the portal using the link shared by your school.' });
    }
    const student = students[0];

    if (student.status && student.status !== 'active') {
      return res.status(403).json({ ok: false, error: 'This student record is not active. Please contact the school office.' });
    }

    // 2. Too many wrong tries recently?
    const now = Date.now();
    if (student.pin_lock_until && new Date(student.pin_lock_until).getTime() > now) {
      return res.status(429).json({ ok: false, error: 'Too many wrong tries. Please wait 15 minutes, or ask the school office for a new PIN.' });
    }

    // 3. Check: the parent's own password, or the school PIN.
    //    The date of birth works only for a child who has neither yet.
    let passwordOk = false;
    if (student.parent_password_hash && sameHash(student.parent_password_hash, sha256(password))) passwordOk = true;
    if (!passwordOk && student.parent_pin_hash && sameHash(student.parent_pin_hash, pinHash(student.id, password))) passwordOk = true;
    if (!passwordOk && !student.parent_password_hash && !student.parent_pin_hash && dobMatches(student.dob, password)) passwordOk = true;

    if (!passwordOk) {
      if (hasPinColumns) {
        const fails = (parseInt(student.pin_fails, 10) || 0) + 1;
        await sbPatch('students?id=eq.' + encodeURIComponent(student.id),
          fails >= 5 ? { pin_fails: 0, pin_lock_until: new Date(now + 15 * 60 * 1000).toISOString() } : { pin_fails: fails });
        if (fails >= 5) {
          return res.status(429).json({ ok: false, error: 'Too many wrong tries. Please wait 15 minutes, or ask the school office for a new PIN.' });
        }
      }
      return res.status(401).json({ ok: false, error: 'Incorrect PIN or password. Please use the parent PIN given by the school.' });
    }
    if (hasPinColumns && student.pin_fails) {
      await sbPatch('students?id=eq.' + encodeURIComponent(student.id), { pin_fails: 0 });
    }

    // 3. Check the school is active
    const schools = await sbGet('schools?school_id=eq.' + encodeURIComponent(student.school_id) +
      '&select=name,subscription_status,status&limit=1');
    const school = (schools && schools[0]) || {};
    if ((school.subscription_status || school.status) === 'suspended') {
      return res.status(403).json({ ok: false, error: 'The school\'s portal is currently unavailable. Please contact the school office.' });
    }

    // 4. Success
    return res.status(200).json({
      ok: true,
      parent_token: makeParentToken(student.school_id, student.id),
      student: {
        student_id: student.id,
        student_name: student.full_name,
        class: student.class,
        section: student.section,
        roll_no: student.roll_no || '',
        admission_no: student.admission_no || '',
        school_id: student.school_id,
        school_name: school.name || '',
        must_change: !student.parent_password_hash
      }
    });

  } catch (err) {
    console.error('parent-login error:', err);
    return res.status(500).json({ ok: false, error: 'Login failed. Please try again in a moment.' });
  }
};
