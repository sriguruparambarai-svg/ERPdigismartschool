// DigiSmart ERP — Report Card API
// One place that works out a report card, so the office copy and the
// parent's PDF always show the same marks, percentage, grade and rank.
// Remarks are written by the office (AI can suggest a draft) and saved.
//
// POST { token, action, ... }
//   card            { exam_id, student_id }   staff: any student · parent: own child, published exams only
//   save_remarks    { exam_id, student_id, remarks }     staff
//   ai_suggest      { exam_id, student_id }   staff → a draft only, not saved
//   remarks_status  { exam_id, class }        staff → which students already have remarks
//
// Rules used everywhere:
//   • An absent subject counts as 0 out of its full marks
//   • Percentage is rounded to one decimal place
//   • Grades come from the school's grading bands
//   • Rank is by total marks within the class for that exam; equal totals share a rank

const crypto = require('crypto');

const SUPABASE_URL = 'https://nkfxrbumhjztmdyepygt.supabase.co';
const AI_MODEL = process.env.REMARKS_MODEL || 'claude-sonnet-4-5';
const MAX_REMARKS = 600;

function getServiceKey() {
  return process.env.SUPABASE_SERVICE_KEY
      || process.env.SUPABASE_SERVICE_ROLE_KEY
      || '';
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

function isParent(s) { return !!(s && s.role === 'parent' && s.stu && s.sid); }

// Owner always; staff need the Exam permission
function isExamStaff(s) {
  if (!s || !s.sid || s.role === 'parent') return false;
  if (s.role !== 'staff') return true;
  const mods = Array.isArray(s.mods) ? s.mods : [];
  return mods.some(m => String(m).split(':')[0] === 'exam');
}

async function sb(method, path, bodyObj, prefer) {
  const key = getServiceKey();
  const opts = {
    method,
    headers: {
      apikey: key,
      Authorization: 'Bearer ' + key,
      'Content-Type': 'application/json',
      Prefer: prefer || 'return=representation'
    }
  };
  if (bodyObj) opts.body = JSON.stringify(bodyObj);
  const r = await fetch(SUPABASE_URL + '/rest/v1/' + path, opts);
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
  if (!r.ok) throw new Error((data && data.message) || ('Database error ' + r.status + ': ' + text));
  return data;
}

const enc = encodeURIComponent;
const num = v => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
const round1 = n => Math.round(n * 10) / 10;

// Build the full report card for one student in one exam
async function buildCard(schoolId, examId, studentId, parentOnly) {
  const exam = (await sb('GET', 'exams?id=eq.' + enc(examId) + '&school_id=eq.' + enc(schoolId)
    + '&select=id,name,type,academic_year,start_date,classes,published_to_parents&limit=1') || [])[0];
  if (!exam) return { error: 'Exam not found.' };
  if (parentOnly && !exam.published_to_parents) return { error: 'Results for this exam are not published yet.' };

  const stu = (await sb('GET', 'students?id=eq.' + enc(studentId) + '&school_id=eq.' + enc(schoolId)
    + '&select=id,full_name,admission_no,roll_no,class,section,father_name,dob&limit=1') || [])[0];
  if (!stu) return { error: 'Student not found.' };
  if (parentOnly && !(Array.isArray(exam.classes) && exam.classes.indexOf(stu.class) !== -1)) {
    return { error: 'This exam is not for your child\'s class.' };
  }

  // Every mark in this class for this exam — needed for the rank
  const classMarks = await sb('GET', 'exam_marks?exam_id=eq.' + enc(examId) + '&class=eq.' + enc(stu.class)
    + '&select=student_id,subject,marks_obtained,max_marks,is_pass,is_absent&limit=5000') || [];
  const mine = classMarks.filter(m => String(m.student_id) === String(studentId));
  if (!mine.length) return { error: 'No marks entered for this student in this exam.' };

  let bands = [];
  try {
    bands = await sb('GET', 'exam_grading?school_id=eq.' + enc(schoolId) + '&select=grade,min_pct&order=min_pct.desc') || [];
  } catch (e) { bands = []; }
  const gradeFor = pct => {
    for (const b of bands) { if (pct >= num(b.min_pct)) return b.grade; }
    return bands.length ? bands[bands.length - 1].grade : '';
  };

  let total = 0, maxTotal = 0, anyFail = false, anyAbsent = false;
  const rows = mine.map(m => {
    const max = num(m.max_marks);
    const obt = m.is_absent ? 0 : num(m.marks_obtained);
    total += obt; maxTotal += max;
    if (m.is_absent) anyAbsent = true;
    else if (m.is_pass === false) anyFail = true;
    return {
      subject: m.subject,
      marks: m.is_absent ? null : obt,
      max: max,
      grade: m.is_absent ? '—' : gradeFor(max > 0 ? (obt / max) * 100 : 0),
      status: m.is_absent ? 'Absent' : (m.is_pass === false ? 'Fail' : 'Pass')
    };
  });
  const pct = maxTotal > 0 ? round1((total / maxTotal) * 100) : 0;

  // Rank: students with higher totals + 1
  const totals = {};
  for (const m of classMarks) {
    const k = String(m.student_id);
    totals[k] = (totals[k] || 0) + (m.is_absent ? 0 : num(m.marks_obtained));
  }
  const all = Object.values(totals);
  const rank = all.filter(t => t > total + 1e-9).length + 1;

  let school = {};
  try { school = (await sb('GET', 'schools?school_id=eq.' + enc(schoolId) + '&select=*&limit=1') || [])[0] || {}; } catch (e) { school = {}; }
  let logo = '';
  try {
    const ic = (await sb('GET', 'icard_settings?school_id=eq.' + enc(schoolId) + '&select=logo_url&limit=1') || [])[0];
    logo = (ic && ic.logo_url) || '';
  } catch (e) { logo = ''; }

  const rem = (await sb('GET', 'report_remarks?exam_id=eq.' + enc(examId) + '&student_id=eq.' + enc(studentId)
    + '&select=remarks,updated_by,updated_at&limit=1') || [])[0];

  return {
    card: {
      exam: { id: exam.id, name: exam.name, type: exam.type || '', academic_year: exam.academic_year || '', date: exam.start_date || '' },
      student: {
        id: stu.id, name: stu.full_name || '', admission_no: stu.admission_no || '', roll_no: stu.roll_no || '',
        class: stu.class || '', section: stu.section || '',
        class_text: (stu.class || '') + (stu.section ? ' ' + stu.section : ''),
        father_name: stu.father_name || ''
      },
      school: {
        name: school.name || '',
        address: [school.address, school.city, school.pincode].filter(Boolean).join(', '),
        contact: [school.phone || school.mobile, school.email].filter(Boolean).join('  ·  ')
      },
      logo_url: logo,
      rows: rows,
      total: total, max_total: maxTotal, pct: pct, grade: gradeFor(pct),
      result: anyFail ? 'FAIL' : (anyAbsent ? 'ABSENT IN SOME SUBJECTS' : 'PASS'),
      rank: rank, class_size: all.length,
      remarks: rem ? rem.remarks : '',
      remarks_updated_at: rem ? rem.updated_at : null
    }
  };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  if (!getServiceKey()) return res.status(500).json({ ok: false, error: 'Server key not configured.' });

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  } catch (e) {
    return res.status(400).json({ ok: false, error: 'Bad request body.' });
  }

  const session = verifyToken(body.token);
  if (!session || !session.sid) return res.status(401).json({ ok: false, error: 'Session expired. Please log in again.' });
  const schoolId = String(session.sid);
  const action = String(body.action || '');
  const examId = String(body.exam_id || '').trim();

  try {
    // ══ The report card itself ══
    if (action === 'card') {
      if (!examId) return res.status(400).json({ ok: false, error: 'Exam missing.' });
      let studentId, parentOnly;
      if (isParent(session)) { studentId = String(session.stu); parentOnly = true; }
      else if (isExamStaff(session)) {
        studentId = String(body.student_id || '').trim(); parentOnly = false;
        if (!studentId) return res.status(400).json({ ok: false, error: 'Student missing.' });
      } else {
        return res.status(403).json({ ok: false, error: 'You do not have permission for report cards.' });
      }
      const out = await buildCard(schoolId, examId, studentId, parentOnly);
      if (out.error) return res.status(400).json({ ok: false, error: out.error });
      return res.status(200).json({ ok: true, card: out.card });
    }

    // Everything below is office only
    if (!isExamStaff(session)) return res.status(403).json({ ok: false, error: 'You do not have permission for report cards.' });

    // ══ Save the office's remarks ══
    if (action === 'save_remarks') {
      const studentId = String(body.student_id || '').trim();
      const remarks = String(body.remarks || '').trim();
      if (!examId || !studentId) return res.status(400).json({ ok: false, error: 'Exam or student missing.' });
      if (remarks.length > MAX_REMARKS) return res.status(400).json({ ok: false, error: 'Remarks are too long (max ' + MAX_REMARKS + ' characters).' });

      // Make sure the exam and student belong to this school
      const ex = await sb('GET', 'exams?id=eq.' + enc(examId) + '&school_id=eq.' + enc(schoolId) + '&select=id&limit=1') || [];
      const st = await sb('GET', 'students?id=eq.' + enc(studentId) + '&school_id=eq.' + enc(schoolId) + '&select=id&limit=1') || [];
      if (!ex.length || !st.length) return res.status(400).json({ ok: false, error: 'Exam or student not found.' });

      if (!remarks) {
        await sb('DELETE', 'report_remarks?exam_id=eq.' + enc(examId) + '&student_id=eq.' + enc(studentId));
        return res.status(200).json({ ok: true, cleared: true });
      }
      const saved = await sb('POST', 'report_remarks?on_conflict=exam_id,student_id', [{
        school_id: schoolId, exam_id: examId, student_id: studentId, remarks: remarks,
        updated_by: String(session.name || (session.role === 'staff' ? 'Staff' : 'Admin')),
        updated_at: new Date().toISOString()
      }], 'return=representation,resolution=merge-duplicates');
      return res.status(200).json({ ok: true, saved: (saved || [])[0] || null });
    }

    // ══ AI draft — built from the real marks, never from outside text ══
    if (action === 'ai_suggest') {
      const studentId = String(body.student_id || '').trim();
      if (!examId || !studentId) return res.status(400).json({ ok: false, error: 'Exam or student missing.' });
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) return res.status(500).json({ ok: false, error: 'AI key not configured in Vercel.' });

      const out = await buildCard(schoolId, examId, studentId, false);
      if (out.error) return res.status(400).json({ ok: false, error: out.error });
      const c = out.card;
      const firstName = String(c.student.name).split(' ')[0] || 'The student';
      const subjects = c.rows.map(r => r.subject + ': ' + (r.marks === null ? 'Absent' : r.marks + '/' + r.max)).join(', ');
      const prompt = 'Write a teacher\'s remark for a school report card.\n'
        + 'Student first name: ' + firstName + '\n'
        + 'Class: ' + c.student.class + '\n'
        + 'Exam: ' + c.exam.name + '\n'
        + 'Overall: ' + c.total + '/' + c.max_total + ' (' + c.pct + '%), grade ' + (c.grade || '-') + ', result ' + c.result + '\n'
        + 'Subjects: ' + subjects + '\n\n'
        + 'Rules: 2-3 sentences, under 50 words, warm and honest. Name one strength and one subject to work on. '
        + 'Simple English that parents in Tamil Nadu can easily read. Do not mention rank. '
        + 'Reply with the remark only — no heading, no quotes.';

      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: AI_MODEL, max_tokens: 200, messages: [{ role: 'user', content: prompt }] })
      });
      const text = await r.text();
      if (!r.ok) return res.status(502).json({ ok: false, error: 'AI could not write a draft: ' + text.slice(0, 300) });
      let draft = '';
      try {
        const d = JSON.parse(text);
        draft = (d.content || []).filter(b => b.type === 'text').map(b => b.text).join(' ').trim();
      } catch (e) { draft = ''; }
      if (!draft) return res.status(502).json({ ok: false, error: 'AI returned an empty draft. Please try again.' });
      return res.status(200).json({ ok: true, draft: draft.slice(0, MAX_REMARKS) });
    }

    // ══ Which students already have remarks ══
    if (action === 'remarks_status') {
      if (!examId) return res.status(400).json({ ok: false, error: 'Exam missing.' });
      const rows = await sb('GET', 'report_remarks?exam_id=eq.' + enc(examId) + '&school_id=eq.' + enc(schoolId)
        + '&select=student_id&limit=5000') || [];
      return res.status(200).json({ ok: true, student_ids: rows.map(r => String(r.student_id)) });
    }

    return res.status(400).json({ ok: false, error: 'Unknown action.' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'Server error: ' + (e.message || e) });
  }
};
