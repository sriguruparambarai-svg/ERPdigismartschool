// DigiSmart ERP — Foundation Question Queue API
// The only door to the parent_questions table. Staff upload a batch of
// daily foundation questions, check them, approve them, and the daily
// job copies one approved question per class into `communications`,
// which is what the parent app already reads.
//
// POST { token, action, ... }
//   upload   { paper }                  → insert a batch as 'waiting'
//   list     {}                         → all batches for this school
//   update   { id, fields }             → edit one question before approval
//   approve  { batch_id }               → mark the whole batch 'approved'
//   remove   { batch_id }               → delete a whole batch
//   send_today { cron_secret }          → daily job (no login token)

const crypto = require('crypto');

const SUPABASE_URL = 'https://nkfxrbumhjztmdyepygt.supabase.co';

// Subjects that may ever reach a parent through this channel.
// NEET and JEE are built only on these. Nothing else is allowed in.
const SUBJECTS_JUNIOR = ['Science', 'Maths'];
const SUBJECTS_SENIOR = ['Physics', 'Chemistry', 'Biology', 'Maths'];

function getServiceKey() {
  return process.env.SUPABASE_SERVICE_KEY
      || process.env.SUPABASE_SERVICE_ROLE_KEY
      || '';
}

// ── Verify the signed staff session token issued at login ──
function verifySessionToken(token) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 2) return null;
    const payload = Buffer.from(parts[0], 'base64').toString('utf8');
    const sig = crypto.createHmac('sha256', getServiceKey()).update(payload).digest('hex');
    if (sig !== parts[1]) return null;
    const d = JSON.parse(payload);
    if (Date.now() > d.exp) return null;
    return d;                                  // { sid, role, mods, exp }
  } catch (e) { return null; }
}

// Owners always. Staff only if they hold the Parent Communication module.
function mayUse(session) {
  if (!session) return false;
  if (session.role === 'parent') return false;   // parent logins never allowed here
  if (session.role !== 'staff') return true;
  const mods = Array.isArray(session.mods) ? session.mods : [];
  return mods.some(m => String(m).split(':')[0] === 'communication');
}

async function sb(method, path, bodyObj, extraHeaders) {
  const key = getServiceKey();
  const headers = {
    apikey: key,
    Authorization: 'Bearer ' + key,
    'Content-Type': 'application/json',
    Prefer: 'return=representation'
  };
  if (extraHeaders) Object.assign(headers, extraHeaders);
  const opts = { method, headers };
  if (bodyObj) opts.body = JSON.stringify(bodyObj);
  const r = await fetch(SUPABASE_URL + '/rest/v1/' + path, opts);
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
  return { ok: r.ok, status: r.status, data, raw: text };
}

function words(s) {
  return String(s || '').trim().split(/\s+/).filter(Boolean).length;
}

// The label is NEVER taken from the uploaded file. It is rebuilt here from
// the class and the stream, so a Class 6 question can never go out calling
// itself a NEET question.
function buildLabel(classLevel, stream) {
  const exam = stream === 'jee' ? 'JEE' : 'NEET';
  const cls = 'Class ' + classLevel;
  if (classLevel >= 6 && classLevel <= 8) {
    return 'Daily Foundation Question · ' + cls + ' · ' + exam + '-style practice';
  }
  if (classLevel >= 9 && classLevel <= 10) {
    return 'Pre-' + exam + ' Foundation Question · ' + cls;
  }
  return exam + ' Practice Question · ' + cls;
}

// Turn one stored question into the text a parent reads.
function buildParentMessage(row) {
  const letter = String(row.answer || '').toLowerCase();
  const map = { a: row.opt_a, b: row.opt_b, c: row.opt_c, d: row.opt_d };
  const answerText = map[letter] || '';
  return row.question + '\n\n'
    + 'A) ' + row.opt_a + '\n'
    + 'B) ' + row.opt_b + '\n'
    + 'C) ' + row.opt_c + '\n'
    + 'D) ' + row.opt_d + '\n\n'
    + 'Answer: ' + letter.toUpperCase() + ', ' + answerText + '\n'
    + 'Why: ' + row.why;
}

// Check an uploaded paper. Returns { rows } or { error }.
function validatePaper(paper, schoolId) {
  if (!paper || typeof paper !== 'object') return { error: 'The file is not a valid question paper.' };

  const classLevel = parseInt(paper.class_level, 10);
  if (!(classLevel >= 6 && classLevel <= 12)) {
    return { error: 'Class must be between 6 and 12. Foundation questions are not sent below Class 6.' };
  }

  const stream = String(paper.stream || '').toLowerCase();
  if (stream !== 'neet' && stream !== 'jee') {
    return { error: 'Stream must be neet or jee.' };
  }

  const subject = String(paper.subject || '').trim();
  const allowed = classLevel <= 10 ? SUBJECTS_JUNIOR : SUBJECTS_SENIOR;
  if (allowed.indexOf(subject) === -1) {
    return { error: 'Subject "' + subject + '" is not allowed for Class ' + classLevel
      + '. Allowed: ' + allowed.join(', ') + '.' };
  }

  const list = Array.isArray(paper.messages) ? paper.messages : [];
  if (list.length < 1) return { error: 'The file has no questions in it.' };
  if (list.length > 40) return { error: 'A single upload can hold at most 40 questions.' };

  const label = buildLabel(classLevel, stream);
  const batchId = crypto.randomUUID();
  const rows = [];

  for (let i = 0; i < list.length; i++) {
    const m = list[i] || {};
    const n = i + 1;
    const need = ['question', 'opt_a', 'opt_b', 'opt_c', 'opt_d', 'answer', 'why'];
    for (const f of need) {
      if (!String(m[f] || '').trim()) return { error: 'Question ' + n + ' is missing "' + f + '".' };
    }
    const ans = String(m.answer).trim().toLowerCase();
    if (['a', 'b', 'c', 'd'].indexOf(ans) === -1) {
      return { error: 'Question ' + n + ': answer must be a, b, c or d.' };
    }
    if (words(m.question) > 25) {
      return { error: 'Question ' + n + ' is longer than 25 words. Parents will not read it.' };
    }
    if (words(m.why) > 40) {
      return { error: 'Question ' + n + ': the "why" line is longer than 40 words.' };
    }
    rows.push({
      school_code: schoolId,
      class_level: classLevel,
      stream: stream,
      subject: subject,
      label: label,
      send_order: parseInt(m.send_order, 10) || n,
      question: String(m.question).trim(),
      opt_a: String(m.opt_a).trim(),
      opt_b: String(m.opt_b).trim(),
      opt_c: String(m.opt_c).trim(),
      opt_d: String(m.opt_d).trim(),
      answer: ans,
      why: String(m.why).trim(),
      status: 'waiting',
      batch_id: batchId
    });
  }
  return { rows: rows, batch_id: batchId, label: label };
}

// A login may only work on its own school. The browser can name the school by
// either its id or its short code, so both are accepted — but only if they
// belong to the school this login was issued for.
async function sameSchool(session, schoolId) {
  const sid = String((session && session.sid) || '');
  if (!sid || !schoolId) return false;
  if (schoolId === sid) return true;
  const r = await sb('GET', 'schools?or=(school_id.eq.' + encodeURIComponent(sid)
    + ',school_code.eq.' + encodeURIComponent(sid) + ')&select=school_id,school_code&limit=1');
  const s = r.ok && r.data && r.data[0];
  if (!s) return false;
  return schoolId === String(s.school_id || '') || schoolId === String(s.school_code || '');
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

  const action = String(body.action || '');

  // ── The daily job. No login token; guarded by a secret instead. ──
  if (action === 'send_today') {
    // Two ways in: the nightly schedule (secret), or a staff member pressing
    // "Send now" in ERP. A staff member can only send for their own school.
    const secret = process.env.CRON_SECRET || '';
    const byCron = secret && String(body.cron_secret || '') === secret;
    let onlySchool = null;

    if (!byCron) {
      const who = verifySessionToken(body.token);
      if (!mayUse(who)) return res.status(401).json({ ok: false, error: 'Not allowed.' });
      onlySchool = String(body.school_id || '').trim();
      if (!onlySchool) return res.status(400).json({ ok: false, error: 'School missing.' });
      if (!(await sameSchool(who, onlySchool))) return res.status(403).json({ ok: false, error: 'Not allowed.' });
    }
    const today = new Date().toISOString().split('T')[0];

    const schoolFilter = onlySchool
      ? '&school_code=eq.' + encodeURIComponent(onlySchool)
      : '';
    const pending = await sb('GET',
      'parent_questions?status=eq.approved' + schoolFilter
      + '&select=*&order=school_code.asc,class_level.asc,send_order.asc&limit=500');
    if (!pending.ok) return res.status(500).json({ ok: false, error: 'Could not read the queue.' });

    // One question per school + class, lowest send_order first.
    const picked = {};
    for (const row of (pending.data || [])) {
      const key = row.school_code + '|' + row.class_level;
      if (!picked[key]) picked[key] = row;
    }

    const sent = [];
    for (const key of Object.keys(picked)) {
      const row = picked[key];

      // Never send the same class twice on the same day.
      const already = await sb('GET',
        'parent_questions?school_code=eq.' + encodeURIComponent(row.school_code)
        + '&class_level=eq.' + row.class_level
        + '&status=eq.sent&sent_on=eq.' + today + '&select=id&limit=1');
      if (already.ok && already.data && already.data.length > 0) continue;

      const ins = await sb('POST', 'communications', [{
        school_id: row.school_code,
        type: 'foundation_question',
        title: row.label,
        message: buildParentMessage(row),
        target_class: 'Class ' + row.class_level,
        priority: 'normal',
        sender_name: 'Foundation Programme',
        created_at: new Date().toISOString()
      }]);
      if (!ins.ok) continue;

      await sb('PATCH', 'parent_questions?id=eq.' + row.id,
        { status: 'sent', sent_on: today });
      sent.push({ school: row.school_code, class: row.class_level, order: row.send_order });
    }
    return res.status(200).json({ ok: true, sent_count: sent.length, sent: sent });
  }

  // ── Everything else needs a logged-in staff member ──
  const session = verifySessionToken(body.token);
  if (!mayUse(session)) {
    return res.status(401).json({ ok: false, error: 'Please log in again.' });
  }

  const schoolId = String(body.school_id || '').trim();
  if (!schoolId) return res.status(400).json({ ok: false, error: 'School missing.' });
  if (!(await sameSchool(session, schoolId))) {
    return res.status(403).json({ ok: false, error: 'This login cannot change another school.' });
  }

  try {
    if (action === 'upload') {
      const checked = validatePaper(body.paper, schoolId);
      if (checked.error) return res.status(400).json({ ok: false, error: checked.error });

      const ins = await sb('POST', 'parent_questions', checked.rows);
      if (!ins.ok) return res.status(500).json({ ok: false, error: 'Could not save: ' + ins.raw });

      return res.status(200).json({
        ok: true, batch_id: checked.batch_id,
        label: checked.label, count: checked.rows.length
      });
    }

    if (action === 'list') {
      const r = await sb('GET',
        'parent_questions?school_code=eq.' + encodeURIComponent(schoolId)
        + '&select=*&order=created_at.desc,send_order.asc&limit=1000');
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Could not load the queue.' });
      return res.status(200).json({ ok: true, rows: r.data || [] });
    }

    if (action === 'update') {
      const id = String(body.id || '');
      const f = body.fields || {};
      if (!id) return res.status(400).json({ ok: false, error: 'Question missing.' });

      const patch = {};
      ['question', 'opt_a', 'opt_b', 'opt_c', 'opt_d', 'why'].forEach(k => {
        if (typeof f[k] === 'string' && f[k].trim()) patch[k] = f[k].trim();
      });
      if (typeof f.answer === 'string') {
        const a = f.answer.trim().toLowerCase();
        if (['a', 'b', 'c', 'd'].indexOf(a) === -1) {
          return res.status(400).json({ ok: false, error: 'Answer must be a, b, c or d.' });
        }
        patch.answer = a;
      }
      if (patch.question && words(patch.question) > 25) {
        return res.status(400).json({ ok: false, error: 'Question is longer than 25 words.' });
      }
      if (patch.why && words(patch.why) > 40) {
        return res.status(400).json({ ok: false, error: 'The "why" line is longer than 40 words.' });
      }
      if (Object.keys(patch).length === 0) {
        return res.status(400).json({ ok: false, error: 'Nothing to change.' });
      }

      // Only questions that have not gone out yet, and only this school's.
      const r = await sb('PATCH',
        'parent_questions?id=eq.' + encodeURIComponent(id)
        + '&school_code=eq.' + encodeURIComponent(schoolId)
        + '&status=neq.sent', patch);
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Could not save the change.' });
      if (!r.data || r.data.length === 0) {
        return res.status(400).json({ ok: false, error: 'That question has already been sent and cannot be changed.' });
      }
      return res.status(200).json({ ok: true, row: r.data[0] });
    }

    if (action === 'approve') {
      const batchId = String(body.batch_id || '');
      if (!batchId) return res.status(400).json({ ok: false, error: 'Batch missing.' });
      const r = await sb('PATCH',
        'parent_questions?batch_id=eq.' + encodeURIComponent(batchId)
        + '&school_code=eq.' + encodeURIComponent(schoolId)
        + '&status=eq.waiting', { status: 'approved' });
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Could not approve.' });
      return res.status(200).json({ ok: true, approved: (r.data || []).length });
    }

    if (action === 'remove') {
      const batchId = String(body.batch_id || '');
      if (!batchId) return res.status(400).json({ ok: false, error: 'Batch missing.' });
      // Sent questions are kept as a record; only unsent ones are removed.
      const r = await sb('DELETE',
        'parent_questions?batch_id=eq.' + encodeURIComponent(batchId)
        + '&school_code=eq.' + encodeURIComponent(schoolId)
        + '&status=neq.sent');
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Could not delete.' });
      return res.status(200).json({ ok: true, removed: (r.data || []).length });
    }

    return res.status(400).json({ ok: false, error: 'Unknown action.' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'Server error: ' + (e.message || e) });
  }
};
