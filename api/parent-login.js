// DigiSmart ERP — Parent Login API (Parent Portal 2.0)
// Verifies the parent's password on the SERVER. Passwords are stored
// hashed; the browser never sees hashes, other children's data, or DOBs.
// Default password remains the child's DOB (DDMMYYYY, or YYYYMMDD).
// POST { admission_no, password, school_id? }

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
    exp: Date.now() + 12 * 60 * 60 * 1000
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
    const admNo = String(body.admission_no || '').trim().toUpperCase();
    const password = String(body.password || '');
    const schoolId = String(body.school_id || '').trim();

    if (!admNo || !password) {
      return res.status(400).json({ ok: false, error: 'Please enter admission number and password.' });
    }

    // 1. Find the student
    let path = 'students?admission_no=eq.' + encodeURIComponent(admNo) +
      '&select=id,full_name,class,section,school_id,parent_password_hash,dob,status';
    if (schoolId) path += '&school_id=eq.' + encodeURIComponent(schoolId);
    const students = await sbGet(path);

    if (!students || students.length === 0) {
      return res.status(401).json({ ok: false, error: 'Admission number not found. Please check and try again.' });
    }
    if (students.length > 1) {
      return res.status(400).json({ ok: false, error: 'Please open the portal using the link shared by your school.' });
    }
    const student = students[0];

    if (student.status && student.status !== 'active') {
      return res.status(403).json({ ok: false, error: 'This student record is not active. Please contact the school office.' });
    }

    // 2. Check password — stored hash first, DOB default otherwise
    let passwordOk = false;
    if (student.parent_password_hash) {
      passwordOk = student.parent_password_hash === sha256(password);
    } else {
      passwordOk = dobMatches(student.dob, password);
    }
    if (!passwordOk) {
      return res.status(401).json({ ok: false, error: 'Incorrect password. Default password is your child\'s date of birth (DDMMYYYY). Example: 15042012' });
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
        admission_no: admNo,
        school_id: student.school_id,
        school_name: school.name || ''
      }
    });

  } catch (err) {
    console.error('parent-login error:', err);
    return res.status(500).json({ ok: false, error: 'Login failed. Please try again in a moment.' });
  }
};
