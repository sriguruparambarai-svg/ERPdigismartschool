// DigiSmart ERP — Parent Data API (Parent Portal 2.0)
// Serves data for exactly ONE child — the one in the parent's signed
// token. A parent can never see any other student's records, and the
// locked fee tables are reachable only through this door.
//
// POST { token, action, ... }
//   attendance      { month: 'YYYY-MM' }  → that month's records
//   fees            {}                    → fee structure + payment history
//   change_password { old_password, new_password }

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

function verifyParentToken(token) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 2) return null;
    const payload = Buffer.from(parts[0], 'base64').toString('utf8');
    const sig = crypto.createHmac('sha256', getServiceKey()).update(payload).digest('hex');
    if (sig !== parts[1]) return null;
    const d = JSON.parse(payload);
    if (d.role !== 'parent') return null;
    if (Date.now() > d.exp) return null;
    return d; // { sid, stu, role, exp }
  } catch (e) { return null; }
}

// Parent PIN (made by the office in Parent Communication) — same scrambling as api/student-data.js
function pinHash(studentId, pin) {
  return crypto.createHmac('sha256', getServiceKey()).update('parent-pin:' + studentId + ':' + String(pin)).digest('hex');
}

// Everything a child's class can see: items for "all" or for this class
function forClass(cls) {
  return '&target_class=in.(' + ['all', cls].map(function (v) { return '"' + String(v || '').replace(/"/g, '') + '"'; }).join(',') + ')';
}

function dobMatches(dob, pw) {
  if (!dob) return false;
  const clean = String(dob).split('T')[0];
  const parts = clean.split('-');
  if (parts.length !== 3) return false;
  return pw === (parts[2] + parts[1] + parts[0]) || pw === (parts[0] + parts[1] + parts[2]);
}

// What the school chooses to show on report cards (Report card settings).
// Anything not set stays ON, so schools that never touch it see everything.
const SHOW_DEFAULT = { marks: true, grade: true, status: true, result: true, pct: true, rank: true, attendance: true, remarks: true };
async function getShow(schoolId) {
  const show = Object.assign({}, SHOW_DEFAULT);
  try {
    const rs = (await sb('GET', 'report_card_settings?school_id=eq.' + encodeURIComponent(schoolId) + '&select=show_items&limit=1') || [])[0];
    const s = (rs && rs.show_items) || {};
    Object.keys(SHOW_DEFAULT).forEach(k => { if (s[k] === false) show[k] = false; });
  } catch (e) { /* not set up yet — show everything */ }
  if (!show.marks && !show.grade) show.marks = true;   // a card must show marks or grades
  return show;
}

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
  if (!r.ok) throw new Error((data && data.message) || ('Database error ' + r.status));
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

  // ── Identity: which child does this token belong to? ──
  const session = verifyParentToken(body.token);
  if (!session) {
    return res.status(401).json({ ok: false, error: 'Session expired. Please log in again.' });
  }
  const schoolId = String(session.sid);
  const studentId = String(session.stu);
  const action = body.action;

  try {
    // ══ ATTENDANCE — one month for this child only ══
    if (action === 'attendance') {
      const month = /^\d{4}-\d{2}$/.test(body.month || '') ? body.month : new Date().toISOString().slice(0, 7);
      const rows = await sb('GET', 'student_attendance?student_id=eq.' + encodeURIComponent(studentId) +
        '&school_id=eq.' + encodeURIComponent(schoolId) +
        '&date=gte.' + month + '-01&date=lte.' + month + '-31' +
        '&select=date,status&order=date.asc');
      return res.status(200).json({ ok: true, month: month, records: rows || [] });
    }

    // ══ FEES — per-head breakdown, scheme waivers, payment history ══
    if (action === 'fees') {
      const stuRows = await sb('GET', 'students?id=eq.' + encodeURIComponent(studentId) +
        '&school_id=eq.' + encodeURIComponent(schoolId) + '&select=class,is_rte&limit=1');
      const cls = stuRows && stuRows[0] ? stuRows[0].class : null;
      const isRte = !!(stuRows && stuRows[0] && stuRows[0].is_rte);

      let structure = [];
      if (cls) {
        structure = await sb('GET', 'fee_structure?school_id=eq.' + encodeURIComponent(schoolId) +
          '&class=eq.' + encodeURIComponent(cls) + '&select=*') || [];
      }
      const payments = await sb('GET', 'fee_payments?student_id=eq.' + encodeURIComponent(studentId) +
        '&school_id=eq.' + encodeURIComponent(schoolId) +
        '&is_cancelled=not.is.true' + // cancelled receipts never count as paid
        '&select=receipt_no,amount_paid,payment_date,payment_mode,fee_head_id,period&order=payment_date.desc') || [];

      // Fee head categories (used to match scheme waivers)
      const heads = await sb('GET', 'fee_heads?school_id=eq.' + encodeURIComponent(schoolId) +
        '&select=id,name,category') || [];
      const headById = {};
      heads.forEach(h => { headById[h.id] = h; });

      // This student's custom fee amounts (e.g. route-based van fee)
      let overrides = [];
      try {
        overrides = await sb('GET', 'student_fee_overrides?student_id=eq.' + encodeURIComponent(studentId) +
          '&school_id=eq.' + encodeURIComponent(schoolId) + '&select=fee_head_id,total_amount,note') || [];
      } catch (e) { overrides = []; } // table may not exist yet
      const ovByHead = {};
      overrides.forEach(o => { ovByHead[o.fee_head_id] = o; });

      // Active 5-Year Scheme enrolment (if the school offers it)
      let scheme = null;
      try {
        const schemes = await sb('GET', 'scheme_enrollments?student_id=eq.' + encodeURIComponent(studentId) +
          '&school_id=eq.' + encodeURIComponent(schoolId) + '&status=eq.active&select=free_van,free_uniform,free_books&limit=1');
        scheme = (schemes && schemes[0]) || null;
      } catch (e) { scheme = null; } // table may not exist for this school

      function isWaived(feeHeadId) {
        if (!scheme) return false;
        const head = headById[feeHeadId];
        if (!head) return false;
        if (head.category === 'transport') return !!scheme.free_van;
        if (head.category === 'uniform') return !!scheme.free_uniform;
        if (head.category === 'books') return !!scheme.free_books;
        // School fees (general heads) are covered by the 5-Year Scheme fee
        if (!head.category || head.category === 'general') return true;
        return false;
      }

      // RTE: general heads free; 'rte' heads charged only to RTE students
      function isRteFree(feeHeadId) {
        if (!isRte) return false;
        const head = headById[feeHeadId];
        if (!head) return false;
        return !head.category || head.category === 'general';
      }
      if (!isRte) {
        structure = structure.filter(s => !(headById[s.fee_head_id] && headById[s.fee_head_id].category === 'rte'));
      }
      // Notebook fee only for 5-Year Scheme students with Free Books (others' book fee covers notebooks)
      if (!(scheme && scheme.free_books)) {
        structure = structure.filter(s => !(headById[s.fee_head_id] && headById[s.fee_head_id].category === 'notebooks'));
      }

      // Paid amount per fee head
      const paidByHead = {};
      let unmatchedPaid = 0;
      payments.forEach(p => {
        const amt = parseFloat(p.amount_paid) || 0;
        if (p.fee_head_id) paidByHead[p.fee_head_id] = (paidByHead[p.fee_head_id] || 0) + amt;
        else unmatchedPaid += amt;
      });

      // One breakdown row per fee head — custom student amount wins over class amount
      const breakdown = structure.map(s => {
        const rteFreeHead = isRteFree(s.fee_head_id);
        const waived = rteFreeHead || isWaived(s.fee_head_id);
        const ov = ovByHead[s.fee_head_id];
        const baseAmount = ov ? (parseFloat(ov.total_amount) || 0) : (parseFloat(s.total_amount) || 0);
        const total = waived ? 0 : baseAmount;
        const paid = paidByHead[s.fee_head_id] || 0;
        let name = s.fee_head_name || (headById[s.fee_head_id] && headById[s.fee_head_id].name) || 'Fee';
        if (ov && ov.note) name = name + ' (' + ov.note + ')';
        delete paidByHead[s.fee_head_id];
        return { name: name, total: total, paid: paid, balance: Math.max(total - paid, 0), waived: waived, waived_by: rteFreeHead ? 'rte' : (waived ? 'scheme' : null) };
      });

      // Payments toward heads not in the structure (e.g. old heads) → still shown
      Object.keys(paidByHead).forEach(hid => {
        const name = (headById[hid] && headById[hid].name) || 'Other Fee';
        breakdown.push({ name: name, total: 0, paid: paidByHead[hid], balance: 0, waived: false });
      });
      if (unmatchedPaid > 0) {
        breakdown.push({ name: 'Other Payments', total: 0, paid: unmatchedPaid, balance: 0, waived: false });
      }

      const totalFee = breakdown.reduce((s, r) => s + r.total, 0);
      const totalPaid = payments.reduce((s, r) => s + (parseFloat(r.amount_paid) || 0), 0);
      const schemeFree = scheme
        ? ['School Fees', scheme.free_van && 'Van', scheme.free_uniform && 'Uniform', scheme.free_books && 'Books'].filter(Boolean)
        : [];

      return res.status(200).json({
        ok: true,
        total_fee: totalFee,
        total_paid: totalPaid,
        balance: Math.max(totalFee - totalPaid, 0),
        breakdown: breakdown,
        scheme_free: schemeFree,
        is_rte: isRte,
        payments: payments
      });
    }

    // ══ EXAM RESULTS — published exams only, this child's marks ══
    // ══ RECEIPT — one receipt of this child only, for the PDF download ══
    if (action === 'receipt') {
      const rno = String(body.receipt_no || '').trim();
      if (!rno || rno.length > 60) return res.status(400).json({ ok: false, error: 'Receipt not found.' });
      const lines = await sb('GET', 'fee_payments?student_id=eq.' + encodeURIComponent(studentId) +
        '&school_id=eq.' + encodeURIComponent(schoolId) +
        '&receipt_no=eq.' + encodeURIComponent(rno) +
        '&is_cancelled=not.is.true' +
        '&select=fee_head_name,period,amount_paid,payment_mode,payment_date,reference_no,is_late_fee&order=created_at.asc') || [];
      if (!lines.length) return res.status(404).json({ ok: false, error: 'Receipt not found.' });

      const stu = (await sb('GET', 'students?id=eq.' + encodeURIComponent(studentId) +
        '&select=full_name,admission_no,class,section,father_name&limit=1') || [])[0] || {};
      let school = {};
      try {
        school = (await sb('GET', 'schools?school_id=eq.' + encodeURIComponent(schoolId) + '&select=*&limit=1') || [])[0] || {};
      } catch (e) { school = {}; }
      let logo = '';
      try {
        const ic = (await sb('GET', 'icard_settings?school_id=eq.' + encodeURIComponent(schoolId) + '&select=logo_url&limit=1') || [])[0];
        logo = (ic && ic.logo_url) || '';
      } catch (e) { logo = ''; }

      // Online payments: show the convenience fee the parent paid on top of the fees
      const items = lines.map(l => ({
        label: (l.fee_head_name || (l.is_late_fee ? 'Late Fee' : 'Fee')) + (l.period ? ' (' + l.period + ')' : ''),
        amount: parseFloat(l.amount_paid) || 0
      }));
      if (rno.indexOf('ONL-') === 0) {
        try {
          const op = (await sb('GET', 'online_payments?receipt_no=eq.' + encodeURIComponent(rno) +
            '&student_id=eq.' + encodeURIComponent(studentId) + '&select=conv_fee&limit=1') || [])[0];
          const cf = op ? parseFloat(op.conv_fee) || 0 : 0;
          if (cf > 0) items.push({ label: 'Online convenience fee', amount: cf });
        } catch (e) { /* table may not exist yet */ }
      }

      return res.status(200).json({
        ok: true,
        receipt: {
          receipt_no: rno,
          payment_date: lines[0].payment_date,
          payment_mode: lines[0].payment_mode,
          reference_no: lines[0].reference_no || '',
          items: items,
          total: items.reduce((t, it) => t + (Number(it.amount) || 0), 0),
          student: {
            name: stu.full_name || '', admission_no: stu.admission_no || '',
            class_text: (stu.class || '') + (stu.section ? ' ' + stu.section : ''),
            father_name: stu.father_name || ''
          },
          school: {
            name: school.name || '',
            address: [school.address, school.city, school.pincode].filter(Boolean).join(', '),
            contact: [school.phone || school.mobile, school.email].filter(Boolean).join('  ·  ')
          },
          logo_url: logo
        }
      });
    }

    if (action === 'exam_results') {
      const stuRows = await sb('GET', 'students?id=eq.' + encodeURIComponent(studentId) +
        '&school_id=eq.' + encodeURIComponent(schoolId) + '&select=class&limit=1');
      const cls = stuRows && stuRows[0] ? stuRows[0].class : null;
      if (!cls) return res.status(200).json({ ok: true, exams: [] });

      // Only exams the school has explicitly published
      const allExams = await sb('GET', 'exams?school_id=eq.' + encodeURIComponent(schoolId) +
        '&published_to_parents=eq.true&select=id,name,type,academic_year,start_date,classes&order=start_date.desc') || [];
      const exams = allExams.filter(e => Array.isArray(e.classes) && e.classes.indexOf(cls) !== -1).slice(0, 8);

      // Grade bands (e.g. A1 >= 91, A2 >= 81 ...)
      let bands = [];
      try {
        bands = await sb('GET', 'exam_grading?school_id=eq.' + encodeURIComponent(schoolId) +
          '&select=grade,min_pct&order=min_pct.desc') || [];
      } catch (e) { bands = []; }
      function gradeFor(pct) {
        for (const b of bands) { if (pct >= parseFloat(b.min_pct)) return b.grade; }
        return bands.length ? bands[bands.length - 1].grade : '';
      }

      const out = [];
      for (const ex of exams) {
        const marks = await sb('GET', 'exam_marks?exam_id=eq.' + encodeURIComponent(ex.id) +
          '&student_id=eq.' + encodeURIComponent(studentId) +
          '&select=subject,marks_obtained,max_marks,is_pass,is_absent') || [];
        if (marks.length === 0) continue; // no marks entered for this child

        let total = 0, maxTotal = 0, anyFail = false, anyAbsent = false;
        const rows = marks.map(m => {
          const max = parseFloat(m.max_marks) || 0;
          const obt = m.is_absent ? 0 : (parseFloat(m.marks_obtained) || 0);
          total += obt; maxTotal += max;
          if (m.is_absent) anyAbsent = true;
          else if (m.is_pass === false) anyFail = true;
          const pct = max > 0 ? (obt / max) * 100 : 0;
          return {
            subject: m.subject,
            marks: m.is_absent ? null : obt,
            max: max,
            grade: m.is_absent ? '—' : gradeFor(pct),
            status: m.is_absent ? 'Absent' : (m.is_pass === false ? 'Fail' : 'Pass')
          };
        });
        const pct = maxTotal > 0 ? Math.round((total / maxTotal) * 1000) / 10 : 0;
        out.push({
          name: ex.name, type: ex.type, academic_year: ex.academic_year,
          date: ex.start_date, rows: rows,
          total: total, max_total: maxTotal, pct: pct,
          grade: gradeFor(pct),
          result: anyFail ? 'FAIL' : (anyAbsent ? 'ABSENT IN SOME SUBJECTS' : 'PASS')
        });
      }
      // Hide what the school has chosen not to show on report cards
      const sh = await getShow(schoolId);
      out.forEach(ex => {
        ex.rows.forEach(r => {
          if (!sh.status) r.status = '';
          if (!sh.grade) r.grade = '';
          if (!sh.marks) { r.marks = undefined; r.max = undefined; }
        });
        if (!sh.marks) { ex.total = undefined; ex.max_total = undefined; }
        if (!sh.grade) ex.grade = '';
        if (!sh.result) ex.result = '';
        if (!sh.pct) ex.pct = undefined;
      });
      return res.status(200).json({ ok: true, exams: out });
    }

    // ══ SCHOOL NOTICES, HOMEWORK, EVENTS, CONSENT FORMS, FOUNDATION QUESTION ══
    // Read on the server for THIS child's class only (the page used to read the
    // whole communications table straight from the database).
    if (action === 'comms') {
      const me = await sb('GET', 'students?id=eq.' + encodeURIComponent(studentId) +
        '&school_id=eq.' + encodeURIComponent(schoolId) + '&select=class&limit=1');
      if (!me || !me.length) return res.status(404).json({ ok: false, error: 'Student record not found.' });
      const cls = me[0].class;
      const today = new Date().toISOString().split('T')[0];
      const base = 'communications?school_id=eq.' + encodeURIComponent(schoolId) + '&select=*';
      let path;
      switch (body.kind) {
        case 'foundation': path = base + '&type=eq.foundation_question' + forClass(cls) + '&order=created_at.desc&limit=1'; break;
        case 'notices':    path = base + '&type=in.(circular,announcement,holiday,event_notice)' + forClass(cls) + '&order=created_at.desc&limit=30'; break;
        case 'homework':   path = base + '&type=eq.homework' + forClass(cls) + '&due_date=gte.' + today + '&order=due_date.asc&limit=20'; break;
        case 'events':     path = base + '&type=eq.event&event_date=gte.' + today + '&order=event_date.asc&limit=10'; break;
        case 'consent':    path = base + '&type=eq.consent_form' + forClass(cls) + '&order=created_at.desc&limit=10'; break;
        default: return res.status(400).json({ ok: false, error: 'Unknown list.' });
      }
      const rows = await sb('GET', path);
      let responses = [];
      if (body.kind === 'consent' && rows && rows.length) {
        const ids = rows.map(function (r) { return '"' + String(r.id).replace(/"/g, '') + '"'; }).join(',');
        responses = await sb('GET', 'consent_responses?student_id=eq.' + encodeURIComponent(studentId) +
          '&school_id=eq.' + encodeURIComponent(schoolId) + '&comm_id=in.(' + ids + ')&select=*') || [];
      }
      return res.status(200).json({ ok: true, data: rows || [], responses: responses });
    }

    // ══ BIRTHDAY — is today this child's birthday? (India date) ══
    // Worked out from the date of birth, so the card shows even if the
    // morning job has not run. The saved wish (api/push.js) is used if there.
    if (action === 'birthday') {
      const me = await sb('GET', 'students?id=eq.' + encodeURIComponent(studentId) +
        '&school_id=eq.' + encodeURIComponent(schoolId) + '&select=full_name,dob&limit=1');
      if (!me || !me.length || !me[0].dob) return res.status(200).json({ ok: true, is_birthday: false });
      const today = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
      if (String(me[0].dob).slice(5, 10) !== today.slice(5)) return res.status(200).json({ ok: true, is_birthday: false });
      const first = String(me[0].full_name || '').trim().split(/\s+/)[0] || 'dear child';
      let message = 'Happy birthday, ' + first + '! Wishing you a very happy year ahead. With love, from everyone at school.';
      try {
        const w = await sb('GET', 'birthday_wishes?student_id=eq.' + encodeURIComponent(studentId) +
          '&wish_date=eq.' + today + '&select=message&limit=1');
        if (w && w[0] && w[0].message) message = w[0].message;
      } catch (e) { /* no saved wish yet — the default message is used */ }
      return res.status(200).json({ ok: true, is_birthday: true, name: first, message: message });
    }

    // ══ SCHOOL GALLERY — albums for everyone or this child's class ══
    if (action === 'gallery') {
      const me = await sb('GET', 'students?id=eq.' + encodeURIComponent(studentId) +
        '&school_id=eq.' + encodeURIComponent(schoolId) + '&select=class&limit=1');
      if (!me || !me.length) return res.status(404).json({ ok: false, error: 'Student record not found.' });
      const rows = await sb('GET', 'gallery_albums?school_code=eq.' + encodeURIComponent(schoolId) +
        '&select=*' + forClass(me[0].class) + '&order=event_date.desc&limit=30');
      return res.status(200).json({ ok: true, data: rows || [] });
    }

    // ══ ANSWER A CONSENT FORM / MARK HOMEWORK DONE — only for this child ══
    if (action === 'consent_submit' || action === 'hw_done') {
      const commId = String(body.comm_id || '');
      const wantType = action === 'consent_submit' ? 'consent_form' : 'homework';
      const comm = await sb('GET', 'communications?id=eq.' + encodeURIComponent(commId) +
        '&school_id=eq.' + encodeURIComponent(schoolId) + '&type=eq.' + wantType + '&select=id&limit=1');
      if (!comm || !comm.length) return res.status(404).json({ ok: false, error: 'This item was not found.' });
      const me = await sb('GET', 'students?id=eq.' + encodeURIComponent(studentId) +
        '&school_id=eq.' + encodeURIComponent(schoolId) + '&select=full_name,class&limit=1');
      const kid = (me && me[0]) || {};
      const now = new Date().toISOString();
      try {
        if (action === 'consent_submit') {
          const answer = String(body.response || '').substring(0, 60);
          if (!answer) return res.status(400).json({ ok: false, error: 'Please choose an answer.' });
          await sb('POST', 'consent_responses', [{ school_id: schoolId, comm_id: commId, student_id: studentId,
            student_name: kid.full_name || '', class: kid.class || '', response: answer, responded_at: now }]);
        } else {
          await sb('POST', 'hw_completions', [{ school_id: schoolId, comm_id: commId, student_id: studentId,
            student_name: kid.full_name || '', completed_at: now }]);
        }
      } catch (e) {
        if (!/duplicate/i.test(String(e.message))) throw e;   // already answered: fine
      }
      return res.status(200).json({ ok: true });
    }

    // ══ CHANGE PASSWORD ══
    if (action === 'change_password') {
      const oldPw = String(body.old_password || '');
      const newPw = String(body.new_password || '');
      if (newPw.length < 6) {
        return res.status(400).json({ ok: false, error: 'New password must be at least 6 characters.' });
      }

      let rows;
      try {
        rows = await sb('GET', 'students?id=eq.' + encodeURIComponent(studentId) +
          '&school_id=eq.' + encodeURIComponent(schoolId) + '&select=parent_password_hash,parent_pin_hash,dob&limit=1');
      } catch (e) {   // PIN columns not added yet
        rows = await sb('GET', 'students?id=eq.' + encodeURIComponent(studentId) +
          '&school_id=eq.' + encodeURIComponent(schoolId) + '&select=parent_password_hash,dob&limit=1');
      }
      if (!rows || rows.length === 0) {
        return res.status(404).json({ ok: false, error: 'Student record not found.' });
      }
      const s = rows[0];

      let oldOk = false;
      if (s.parent_password_hash) oldOk = s.parent_password_hash === sha256(oldPw);
      else if (s.parent_pin_hash) oldOk = s.parent_pin_hash === pinHash(studentId, oldPw);
      else oldOk = dobMatches(s.dob, oldPw);
      if (!oldOk) {
        return res.status(401).json({ ok: false, error: 'Current password is incorrect.' });
      }

      await sb('PATCH', 'students?id=eq.' + encodeURIComponent(studentId), {
        parent_password_hash: sha256(newPw)
      });
      return res.status(200).json({ ok: true });
    }

    // ══ FIRST PASSWORD ══
    // Only works while the password is still the birth date. The login token
    // is the proof, so the parent does not have to type the old one again.
    if (action === 'set_first_password') {
      const newPw = String(body.new_password || '');
      if (newPw.length < 6) {
        return res.status(400).json({ ok: false, error: 'Password must be at least 6 characters.' });
      }

      const rows = await sb('GET', 'students?id=eq.' + encodeURIComponent(studentId) +
        '&school_id=eq.' + encodeURIComponent(schoolId) + '&select=parent_password_hash,dob&limit=1');
      if (!rows || rows.length === 0) {
        return res.status(404).json({ ok: false, error: 'Student record not found.' });
      }
      if (rows[0].parent_password_hash) {
        return res.status(400).json({ ok: false, error: 'A password is already set. Please change it from Settings.' });
      }
      if (dobMatches(rows[0].dob, newPw)) {
        return res.status(400).json({ ok: false, error: 'Please choose something other than the date of birth.' });
      }

      await sb('PATCH', 'students?id=eq.' + encodeURIComponent(studentId), {
        parent_password_hash: sha256(newPw)
      });
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ ok: false, error: 'Unknown action.' });

  } catch (err) {
    console.error('parent-data error:', err);
    return res.status(500).json({ ok: false, error: 'Something went wrong. Please try again.' });
  }
};
