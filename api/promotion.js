// DigiSmart ERP — Year-end promotion (Nov 2026)
// One screen, the whole school: every active child moves to the next class for the new
// academic year; children the office unticks repeat their class; the school's last class
// is marked "Passed out". Each child's unpaid fees from the year being closed are carried
// into the new year as "Previous Year Balance" (fee_arrears), and the school's fee year
// moves on, so last year's payments no longer count for this year's fees.
// Runs once per year per school; can be undone the same day if no new-year fee was taken.
// Owner login only. Needs step-promotion.sql.
//
// POST { token, action: 'preview' }                                  → classes, counts, dues to carry
// POST { token, action: 'run', from_year, last_class, repeat: [ids] } → done
// POST { token, action: 'undo' }                                      → today's promotion reversed

const crypto = require('crypto');
const { computeSchoolDues, feeYear, nextYear } = require('./_fees');
const { sb, enc, getServiceKey } = require('./_push');

// Class ladder. Any class not on it stays where it is (shown to the office).
const LADDER = ['PreKG', 'LKG', 'UKG', 'Class 1', 'Class 2', 'Class 3', 'Class 4', 'Class 5', 'Class 6',
  'Class 7', 'Class 8', 'Class 9', 'Class 10', 'Class 11', 'Class 12'];
function rung(c) {
  const t = String(c || '').trim();
  if (/^pre\s*-?\s*kg$/i.test(t)) return 0;
  const i = LADDER.findIndex(x => x.toLowerCase() === t.toLowerCase());
  if (i !== -1) return i;
  const m = /^(?:class|std|standard|grade)?\s*(\d{1,2})$/i.exec(t);
  return m && +m[1] >= 1 && +m[1] <= 12 ? 2 + +m[1] : -1;
}
function nextClass(c) { const r = rung(c); return r === -1 || r >= LADDER.length - 1 ? null : LADDER[r + 1]; }
function istToday() { return new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10); }

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
async function getAll(path) {
  let out = [];
  for (let off = 0; off < 100000; off += 1000) {
    const rows = await sb('GET', path + '&limit=1000&offset=' + off) || [];
    out = out.concat(rows);
    if (rows.length < 1000) break;
  }
  return out;
}

async function look(schoolId) {
  const sid = enc(schoolId);
  const settings = (await sb('GET', 'fee_settings?school_id=eq.' + sid + '&select=*&limit=1') || [])[0] || null;
  const students = await getAll('students?school_id=eq.' + sid + '&status=eq.active&select=id,full_name,admission_no,class,section,academic_year&order=full_name.asc');
  // The year being closed: the school's fee year, or (if never set) the year most children are in
  let fy = settings && /^\d{4}-\d{2}$/.test(String(settings.current_year || '')) ? String(settings.current_year) : '';
  if (!fy) {
    const cnt = {};
    students.forEach(st => { if (/^\d{4}-\d{2}$/.test(String(st.academic_year || ''))) cnt[st.academic_year] = (cnt[st.academic_year] || 0) + 1; });
    fy = Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a])[0] || feeYear(settings);
  }
  const ny = nextYear(fy);
  const done = (await sb('GET', 'promotions?school_id=eq.' + sid + '&from_year=eq.' + enc(fy) + '&select=id,to_year,done_at,counts&limit=1').catch(() => null) || [])[0] || null;
  return { settings, fy, ny, students, done };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  if (!getServiceKey()) return res.status(500).json({ ok: false, error: 'Server key not configured.' });
  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); }
  catch (e) { return res.status(400).json({ ok: false, error: 'Invalid request.' }); }
  const s = verifyToken(body.token);
  if (!s || !s.sid) return res.status(401).json({ ok: false, error: 'Session expired. Please log in again.' });
  if (s.role !== 'owner') return res.status(403).json({ ok: false, error: 'Only the owner login can promote the school.' });
  const schoolId = String(s.sid);
  const action = String(body.action || '');

  try {
    // ── What would happen ──
    if (action === 'preview') {
      const L = await look(schoolId);
      const byClass = {};
      L.students.forEach(st => {
        const k = String(st.class || '—');
        (byClass[k] = byClass[k] || []).push({ id: st.id, name: st.full_name, adm: st.admission_no || '', section: st.section || '' });
      });
      const classes = Object.keys(byClass).sort((a, b) => (rung(a) === -1 ? 99 : rung(a)) - (rung(b) === -1 ? 99 : rung(b)) || a.localeCompare(b));
      const known = classes.filter(c => rung(c) !== -1);
      const lastDefault = known.length ? known[known.length - 1] : '';
      // Unpaid fees that will be carried forward
      let carry = { students: 0, amount: 0 };
      try {
        const d = await computeSchoolDues(sb, schoolId);
        d.results.forEach(r => {
          const amt = r.items.filter(it => it.group !== 'arrears').reduce((a, it) => a + (Number(it.amount) || 0), 0);
          if (amt > 0) { carry.students++; carry.amount += amt; }
        });
        carry.amount = Math.round(carry.amount);
      } catch (e) { carry = null; }
      return res.status(200).json({ ok: true, from_year: L.fy, to_year: L.ny, done: L.done,
        classes: classes.map(c => ({ class: c, next: nextClass(c), known: rung(c) !== -1, students: byClass[c] })),
        last_class: lastDefault, carry });
    }

    // ── Promote the whole school ──
    if (action === 'run') {
      const L = await look(schoolId);
      if (String(body.from_year || '') !== L.fy) return res.status(400).json({ ok: false, error: 'The year has changed. Please open the page again.' });
      if (L.done) return res.status(400).json({ ok: false, error: 'This school was already promoted from ' + L.fy + '.' });
      const last = String(body.last_class || '');
      const repeat = new Set((Array.isArray(body.repeat) ? body.repeat : []).map(String));

      // 1. Each child's unpaid fees of the closing year (before anything moves)
      if (!L.settings) { await sb('POST', 'fee_settings', [{ school_id: schoolId, current_year: L.fy }], 'return=minimal'); L.settings = { current_year: L.fy }; }
      else if (L.settings.current_year !== L.fy) await sb('PATCH', 'fee_settings?school_id=eq.' + enc(schoolId), { current_year: L.fy }, 'return=minimal');
      const dues = await computeSchoolDues(sb, schoolId);
      const arrears = [];
      dues.results.forEach(r => {
        const items = r.items.filter(it => it.group !== 'arrears' && Number(it.amount) > 0);
        const amt = Math.round(items.reduce((a, it) => a + Number(it.amount), 0) * 100) / 100;
        if (amt > 0) arrears.push({ school_id: schoolId, student_id: r.student.id, from_year: L.fy, amount: amt,
          lines: items.map(it => ({ text: it.label, amount: Number(it.amount) })) });
      });

      // 2. Who goes where
      const changes = [], groups = {};
      let promoted = 0, repeated = 0, passed = 0, stayed = 0;
      L.students.forEach(st => {
        const ch = { id: st.id, name: st.full_name, old_class: st.class, old_year: st.academic_year || null, old_status: 'active' };
        let patch;
        if (repeat.has(String(st.id))) { patch = { academic_year: L.ny }; ch.result = 'repeat'; repeated++; }
        else if (last && String(st.class) === last) { patch = { status: 'passed_out' }; ch.result = 'passed_out'; passed++; }
        else {
          const nc = nextClass(st.class);
          if (nc) { patch = { class: nc, academic_year: L.ny }; ch.result = 'promoted'; ch.new_class = nc; promoted++; }
          else { patch = { academic_year: L.ny }; ch.result = 'stayed'; stayed++; }   // class not on the ladder
        }
        changes.push(ch);
        const k = JSON.stringify(patch);
        (groups[k] = groups[k] || []).push(st.id);
      });
      const counts = { promoted, repeated, passed_out: passed, stayed, carried: arrears.length,
        carried_amount: Math.round(arrears.reduce((a, x) => a + x.amount, 0)) };

      // 3. Record it first — the database refuses a second promotion for this year
      const prom = await sb('POST', 'promotions', [{ school_id: schoolId, from_year: L.fy, to_year: L.ny, changes, counts,
        done_by: s.name || s.email || 'Owner' }], 'return=representation');
      const promId = prom && prom[0] && prom[0].id;
      if (!promId) return res.status(500).json({ ok: false, error: 'Could not start the promotion.' });

      // 4. Carry forward unpaid fees
      for (let i = 0; i < arrears.length; i += 200) {
        await sb('POST', 'fee_arrears?on_conflict=school_id,student_id,from_year',
          arrears.slice(i, i + 200).map(a => Object.assign({ promotion_id: promId }, a)), 'return=minimal,resolution=ignore-duplicates');
      }
      // 5. Move the children
      for (const k of Object.keys(groups)) {
        const patch = Object.assign(JSON.parse(k), { updated_at: new Date().toISOString() });
        const ids = groups[k];
        for (let i = 0; i < ids.length; i += 100) {
          await sb('PATCH', 'students?school_id=eq.' + enc(schoolId) + '&id=in.(' + ids.slice(i, i + 100).map(enc).join(',') + ')', patch, 'return=minimal');
        }
      }
      // 6. The school's fee year moves on
      if (L.settings) await sb('PATCH', 'fee_settings?school_id=eq.' + enc(schoolId), { current_year: L.ny }, 'return=minimal');
      else await sb('POST', 'fee_settings', [{ school_id: schoolId, current_year: L.ny }], 'return=minimal');

      return res.status(200).json({ ok: true, from_year: L.fy, to_year: L.ny, counts });
    }

    // ── Undo today's promotion ──
    if (action === 'undo') {
      const settings = (await sb('GET', 'fee_settings?school_id=eq.' + enc(schoolId) + '&select=*&limit=1') || [])[0] || null;
      const fy = feeYear(settings);
      const p = (await sb('GET', 'promotions?school_id=eq.' + enc(schoolId) + '&to_year=eq.' + enc(fy) + '&select=*&order=done_at.desc&limit=1') || [])[0];
      if (!p) return res.status(400).json({ ok: false, error: 'There is no promotion to undo.' });
      if (String(new Date(new Date(p.done_at).getTime() + 5.5 * 3600 * 1000).toISOString().slice(0, 10)) !== istToday()) {
        return res.status(400).json({ ok: false, error: 'A promotion can only be undone on the day it was done.' });
      }
      const newFees = await sb('GET', 'fee_payments?school_id=eq.' + enc(schoolId) + '&academic_year=eq.' + enc(p.to_year) + '&is_cancelled=not.is.true&select=id&limit=1') || [];
      if (newFees.length) return res.status(400).json({ ok: false, error: 'Fees have already been collected for ' + p.to_year + ', so the promotion cannot be undone.' });
      const groups = {};
      (p.changes || []).forEach(ch => {
        const patch = { class: ch.old_class, academic_year: ch.old_year, status: ch.old_status || 'active' };
        const k = JSON.stringify(patch);
        (groups[k] = groups[k] || []).push(ch.id);
      });
      for (const k of Object.keys(groups)) {
        const ids = groups[k];
        for (let i = 0; i < ids.length; i += 100) {
          await sb('PATCH', 'students?school_id=eq.' + enc(schoolId) + '&id=in.(' + ids.slice(i, i + 100).map(enc).join(',') + ')',
            Object.assign(JSON.parse(k), { updated_at: new Date().toISOString() }), 'return=minimal');
        }
      }
      await sb('DELETE', 'fee_arrears?school_id=eq.' + enc(schoolId) + '&promotion_id=eq.' + enc(p.id), null, 'return=minimal');
      await sb('PATCH', 'fee_settings?school_id=eq.' + enc(schoolId), { current_year: p.from_year }, 'return=minimal');
      await sb('DELETE', 'promotions?id=eq.' + enc(p.id), null, 'return=minimal');
      return res.status(200).json({ ok: true, back_to: p.from_year });
    }

    return res.status(400).json({ ok: false, error: 'Unknown action.' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};

module.exports.nextClass = nextClass;
