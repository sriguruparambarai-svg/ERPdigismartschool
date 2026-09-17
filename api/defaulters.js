// DigiSmart ERP — Homework & Class Test Defaulters API
// Teachers mark children who did not do homework or a class test.
// The office checks the list and sends it. Each parent sees only
// their own child's messages. The message text is always built here,
// on the server, never taken from the browser.
//
// POST { token, action, ... }
//   Teacher (admin, or staff with the "defaulters" permission, any level):
//     students  { class, section }                         → class list
//     save      { work_date, kind, class, section, subject, lesson,
//                 student_ids[]            (homework / not written / absent)
//                 marks{id:score}, total_marks  (low marks), staff_name }
//     day_list  { work_date, class, section }              → already marked
//     remove    { id }                                     → only if not sent yet
//   Office (admin, or staff with "defaulters" full access):
//     pending   {}                                         → everything waiting
//     send      { ids[] }                                  → mark as sent
//     repeat    { month }                                  → counts per child
//   Parent:
//     my_notes  {}                                         → last 30 days, sent only

const crypto = require('crypto');

const SUPABASE_URL = 'https://nkfxrbumhjztmdyepygt.supabase.co';

// Below this percentage a class test mark counts as low. Change here if needed.
const PASS_PERCENT = 35;

const KINDS = ['homework', 'test_not_written', 'test_absent', 'test_low_marks'];

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

function isParent(s) {
  return !!(s && s.role === 'parent' && s.stu && s.sid);
}

// Teachers: admins always; staff with "defaulters" at any level.
function canMark(s) {
  if (!s || !s.sid || s.role === 'parent') return false;
  if (s.role !== 'staff') return true;
  const mods = Array.isArray(s.mods) ? s.mods : [];
  return mods.some(m => String(m).split(':')[0] === 'defaulters');
}

// Office: admins always; staff with "defaulters" full access
// (saved as plain 'defaulters' or 'defaulters:full', not 'defaulters:mark').
function canSend(s) {
  if (!s || !s.sid || s.role === 'parent') return false;
  if (s.role !== 'staff') return true;
  const mods = Array.isArray(s.mods) ? s.mods : [];
  return mods.some(m => m === 'defaulters' || m === 'defaulters:full');
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
  return { ok: r.ok, status: r.status, data, raw: text };
}

const enc = encodeURIComponent;

function validDate(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s + 'T00:00:00Z').getTime());
}

function istToday() {
  return new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
}

function niceDate(s) {
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const d = new Date(s + 'T00:00:00Z');
  return d.getUTCDate() + ' ' + months[d.getUTCMonth()];
}

function clean(s, max) {
  return String(s || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

// The words a parent reads. English only, same as other parent messages.
function buildMessage(kind, name, date, subject, lesson, marks, total) {
  const where = subject + ' – ' + lesson;
  const on = niceDate(date);
  if (kind === 'homework') {
    return 'Your child ' + name + ' did not write the Homework given on ' + on + ' in ' + where
      + '. Kindly make sure your ward writes the homework properly.';
  }
  if (kind === 'test_not_written') {
    return 'Your child ' + name + ' did not write / was not prepared for the Class Test on ' + on + ' in ' + where
      + '. Kindly make sure your ward prepares properly.';
  }
  if (kind === 'test_absent') {
    return 'Your child ' + name + ' was absent for the Class Test on ' + on + ' in ' + where
      + '. Kindly help your ward catch up on this lesson.';
  }
  return 'Your child ' + name + ' scored ' + marks + ' out of ' + total + ' in the Class Test on ' + on + ' in ' + where
    + '. Kindly give extra attention to this lesson at home.';
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
    return res.status(400).json({ ok: false, error: 'Bad request body.' });
  }

  const session = verifyToken(body.token);
  if (!session) return res.status(401).json({ ok: false, error: 'Please log in again.' });

  const action = String(body.action || '');

  try {
    // ══ PARENT: this child's messages only ══
    if (action === 'my_notes') {
      if (!isParent(session)) return res.status(403).json({ ok: false, error: 'Parents only.' });
      const since = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
      const r = await sb('GET', 'defaulter_entries?school_id=eq.' + enc(String(session.sid))
        + '&student_id=eq.' + enc(String(session.stu))
        + '&status=eq.sent&work_date=gte.' + since
        + '&select=id,kind,subject,lesson,work_date,message,sent_at&order=sent_at.desc&limit=30');
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Could not load messages.' });
      return res.status(200).json({ ok: true, rows: r.data || [] });
    }

    // The school always comes from the login, never from the browser.
    if (!canMark(session)) return res.status(401).json({ ok: false, error: 'Please log in again.' });
    const schoolId = String(session.sid);

    // ══ TEACHER ══
    if (action === 'students') {
      const cls = clean(body.class, 40);
      const sec = clean(body.section, 10);
      if (!cls) return res.status(400).json({ ok: false, error: 'Please pick a class.' });
      let q = 'students?school_id=eq.' + enc(schoolId) + '&class=eq.' + enc(cls)
        + '&status=eq.active&select=id,full_name,admission_no&order=full_name.asc&limit=200';
      if (sec) q += '&section=eq.' + enc(sec);
      const r = await sb('GET', q);
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Could not load students: ' + r.raw });
      return res.status(200).json({ ok: true, rows: r.data || [], pass_percent: PASS_PERCENT });
    }

    if (action === 'save') {
      const workDate = String(body.work_date || '');
      const kind = String(body.kind || '');
      const cls = clean(body.class, 40);
      const sec = clean(body.section, 10) || null;
      const subject = clean(body.subject, 60);
      const lesson = clean(body.lesson, 100);
      const staffName = clean(body.staff_name, 80) || (session.role === 'staff' ? 'Staff' : 'Admin');

      if (!validDate(workDate)) return res.status(400).json({ ok: false, error: 'Please pick the date the work was given.' });
      if (workDate > istToday()) return res.status(400).json({ ok: false, error: 'The date cannot be in the future.' });
      if (KINDS.indexOf(kind) === -1) return res.status(400).json({ ok: false, error: 'Please choose Homework or a Class Test type.' });
      if (!cls) return res.status(400).json({ ok: false, error: 'Please pick a class.' });
      if (!subject) return res.status(400).json({ ok: false, error: 'Please pick the subject.' });
      if (!lesson) return res.status(400).json({ ok: false, error: 'Please type the lesson name.' });

      // Who is being marked, and (for low marks) with what score
      let wanted = [];
      let total = null;
      const scoreOf = {};
      if (kind === 'test_low_marks') {
        total = Number(body.total_marks);
        if (!(total > 0 && total <= 1000)) return res.status(400).json({ ok: false, error: 'Please enter the total marks of the test.' });
        const marks = body.marks && typeof body.marks === 'object' ? body.marks : {};
        for (const id of Object.keys(marks)) {
          const v = String(marks[id]).trim();
          if (v === '') continue;
          const n = Number(v);
          if (isNaN(n) || n < 0 || n > total) {
            return res.status(400).json({ ok: false, error: 'A mark is more than the total or not a number. Please check.' });
          }
          if ((n / total) * 100 < PASS_PERCENT) { wanted.push(String(id)); scoreOf[String(id)] = n; }
        }
      } else {
        wanted = (Array.isArray(body.student_ids) ? body.student_ids : []).map(String);
      }
      wanted = [...new Set(wanted)].slice(0, 200);
      if (wanted.length === 0) {
        return res.status(200).json({ ok: true, saved: 0, note: kind === 'test_low_marks'
          ? 'No child is below ' + PASS_PERCENT + '%. Nothing to send.' : 'No child was ticked.' });
      }

      // Names come from the school's own records, and only for this class
      const stu = await sb('GET', 'students?school_id=eq.' + enc(schoolId) + '&class=eq.' + enc(cls)
        + '&id=in.(' + wanted.map(enc).join(',') + ')&select=id,full_name');
      if (!stu.ok) return res.status(500).json({ ok: false, error: 'Could not check students: ' + stu.raw });

      const rows = (stu.data || []).map(s => {
        const id = String(s.id);
        const name = clean(s.full_name, 80) || 'your ward';
        return {
          school_id: schoolId, work_date: workDate, kind: kind, class: cls, section: sec,
          subject: subject, lesson: lesson, student_id: id, student_name: name,
          marks: kind === 'test_low_marks' ? scoreOf[id] : null,
          total_marks: kind === 'test_low_marks' ? total : null,
          message: buildMessage(kind, name, workDate, subject, lesson, scoreOf[id], total),
          status: 'pending', marked_by: staffName
        };
      });
      if (rows.length === 0) return res.status(400).json({ ok: false, error: 'Those students are not in this class.' });

      // Already-marked children are skipped quietly, not saved twice
      const ins = await sb('POST',
        'defaulter_entries?on_conflict=school_id,student_id,work_date,kind,subject,lesson',
        rows, 'return=representation,resolution=ignore-duplicates');
      if (!ins.ok) return res.status(500).json({ ok: false, error: 'Could not save: ' + ins.raw });

      const saved = (ins.data || []).length;
      return res.status(200).json({ ok: true, saved: saved, already: rows.length - saved });
    }

    if (action === 'day_list') {
      const workDate = String(body.work_date || '');
      const cls = clean(body.class, 40);
      if (!validDate(workDate) || !cls) return res.status(400).json({ ok: false, error: 'Pick a class and date.' });
      let q = 'defaulter_entries?school_id=eq.' + enc(schoolId) + '&work_date=eq.' + workDate
        + '&class=eq.' + enc(cls) + '&select=*&order=created_at.desc&limit=300';
      const sec = clean(body.section, 10);
      if (sec) q += '&section=eq.' + enc(sec);
      const r = await sb('GET', q);
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Could not load the list.' });
      return res.status(200).json({ ok: true, rows: r.data || [] });
    }

    if (action === 'remove') {
      const id = String(body.id || '');
      if (!id) return res.status(400).json({ ok: false, error: 'Entry missing.' });
      const r = await sb('DELETE', 'defaulter_entries?id=eq.' + enc(id)
        + '&school_id=eq.' + enc(schoolId) + '&status=eq.pending');
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Could not remove.' });
      if (!r.data || r.data.length === 0) {
        return res.status(400).json({ ok: false, error: 'That message has already gone to the parent and cannot be removed.' });
      }
      return res.status(200).json({ ok: true });
    }

    // ══ OFFICE ══
    if (['pending', 'send', 'repeat'].indexOf(action) !== -1 && !canSend(session)) {
      return res.status(403).json({ ok: false, error: 'Only the office can send messages to parents.' });
    }

    if (action === 'pending') {
      const r = await sb('GET', 'defaulter_entries?school_id=eq.' + enc(schoolId)
        + '&status=eq.pending&select=*&order=class.asc,work_date.desc,subject.asc,student_name.asc&limit=1000');
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Could not load the list.' });
      return res.status(200).json({ ok: true, rows: r.data || [] });
    }

    if (action === 'send') {
      const ids = (Array.isArray(body.ids) ? body.ids : []).map(String).filter(Boolean).slice(0, 500);
      if (ids.length === 0) return res.status(400).json({ ok: false, error: 'Nothing chosen to send.' });
      const sentIds = [];
      for (let i = 0; i < ids.length; i += 80) {
        const part = ids.slice(i, i + 80);
        const r = await sb('PATCH', 'defaulter_entries?school_id=eq.' + enc(schoolId)
          + '&status=eq.pending&id=in.(' + part.map(enc).join(',') + ')',
          { status: 'sent', sent_at: new Date().toISOString() });
        if (!r.ok) return res.status(500).json({ ok: false, error: 'Could not send: ' + r.raw, sent_ids: sentIds });
        (r.data || []).forEach(x => sentIds.push(x.id));
      }
      return res.status(200).json({ ok: true, sent: sentIds.length, sent_ids: sentIds });
    }

    if (action === 'repeat') {
      const month = /^\d{4}-\d{2}$/.test(body.month || '') ? body.month : istToday().slice(0, 7);
      const r = await sb('GET', 'defaulter_entries?school_id=eq.' + enc(schoolId)
        + '&work_date=gte.' + month + '-01&work_date=lte.' + month + '-31'
        + '&select=student_id,student_name,class,section,kind&limit=5000');
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Could not load the report.' });
      const byChild = {};
      for (const e of (r.data || [])) {
        const k = e.student_id;
        if (!byChild[k]) byChild[k] = { student_name: e.student_name, class: e.class, section: e.section,
          homework: 0, test_not_written: 0, test_absent: 0, test_low_marks: 0, total: 0 };
        byChild[k][e.kind]++;
        byChild[k].total++;
      }
      const rows = Object.values(byChild).sort((a, b) => b.total - a.total);
      return res.status(200).json({ ok: true, month: month, rows: rows });
    }

    return res.status(400).json({ ok: false, error: 'Unknown action.' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'Server error: ' + (e.message || e) });
  }
};
