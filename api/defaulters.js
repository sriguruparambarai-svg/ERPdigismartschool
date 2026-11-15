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
//     seen_list { date }                                   → sent that day, with seen_at (Nov 2026)
//   Parent:
//     my_notes  {}                                         → last 30 days, sent only
//               (the newest 5, shown on the home screen, get seen_at the first time)
//
// Oct 2026: kind 'discipline' — uniform, shoes, nails, hair, books, ID card.
//   save { kind:'discipline', work_date, class, section, items:{studentId:[codes]} }
//   One combined message per child per day (marking again the same day adds
//   the new items into that one message while it is still waiting).
// Oct 2026: schools with has_tamil_msgs = true get simple Tamil below the English.
// Nov 2026: TeachBot's My Day teacher app sends homework defaulters here (header x-teachbot-key,
//   the same TEACHBOT_LINK_KEY as teachbot-homework.js). action 'hw_check':
//   { school_id, class_name, section?, subject, homework, hw_date, staff_name,
//     kids:[{ roll, name, reason:'not_done'|'half'|'notebook' }] }
//   Children are matched to ERP by roll number in that class (name if the roll is not found).
//   Saving again replaces that teacher's waiting entries for that homework (sent ones stay).
//   The reason is kept in items[] and chooses the message wording.
//   action 'class_list' { school_id, class_name } → rows [{ id, roll, name }] — the class's children
//   from ERP, so the teacher app needs no separate student list. hw_check kids may carry that id.

const crypto = require('crypto');
const { both, defaulterTamil, disciplineMessage, DISCIPLINE_CODES, DISCIPLINE, taDate } = require('./_tamil');

const SUPABASE_URL = 'https://nkfxrbumhjztmdyepygt.supabase.co';

// Below this percentage a class test mark counts as low. Change here if needed.
const PASS_PERCENT = 35;

const KINDS = ['homework', 'test_not_written', 'test_absent', 'test_low_marks', 'discipline'];

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

// Is "Tamil messages" switched on for this school? (off if the column is not there yet)
async function tamilOn(schoolId) {
  const r = await sb('GET', 'schools?school_id=eq.' + enc(schoolId) + '&select=has_tamil_msgs&limit=1');
  return !!(r.ok && r.data && r.data[0] && r.data[0].has_tamil_msgs === true);
}

// The words a parent reads. English first; Tamil below when the school has it on.
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

// ── Nov 2026: each school may change the wording (English box + Tamil box per message) ──
// Blanks: {name} {date} {subject} {lesson} {marks} {total}; discipline uses {name} {date} {items}.
// A message the school has not changed keeps the words above (Tamil only when the Tamil switch is on).
const WORDING_KINDS = ['homework', 'test_not_written', 'test_absent', 'test_low_marks', 'discipline', 'homework_half', 'homework_notebook'];
const DEFAULT_WORDING = {
  homework: {
    en: 'Your child {name} did not write the Homework given on {date} in {subject} – {lesson}. Kindly make sure your ward writes the homework properly.',
    ta: 'உங்கள் குழந்தை {name}, {date} அன்று கொடுத்த {subject} – {lesson} வீட்டுப்பாடத்தை எழுதவில்லை. வீட்டுப்பாடம் எழுத உதவவும்.' },
  test_not_written: {
    en: 'Your child {name} did not write / was not prepared for the Class Test on {date} in {subject} – {lesson}. Kindly make sure your ward prepares properly.',
    ta: 'உங்கள் குழந்தை {name}, {date} அன்று நடந்த {subject} – {lesson} வகுப்புத் தேர்வை எழுதவில்லை / படித்து வரவில்லை. நன்றாகப் படிக்க உதவவும்.' },
  test_absent: {
    en: 'Your child {name} was absent for the Class Test on {date} in {subject} – {lesson}. Kindly help your ward catch up on this lesson.',
    ta: 'உங்கள் குழந்தை {name}, {date} அன்று நடந்த {subject} – {lesson} வகுப்புத் தேர்வுக்கு வரவில்லை. இந்தப் பாடத்தை வீட்டில் படிக்க உதவவும்.' },
  test_low_marks: {
    en: 'Your child {name} scored {marks} out of {total} in the Class Test on {date} in {subject} – {lesson}. Kindly give extra attention to this lesson at home.',
    ta: 'உங்கள் குழந்தை {name}, {date} அன்று நடந்த {subject} – {lesson} வகுப்புத் தேர்வில் {total}-க்கு {marks} மதிப்பெண் பெற்றார். இந்தப் பாடத்தில் வீட்டில் கூடுதல் கவனம் செலுத்தவும்.' },
  discipline: {
    en: 'Your child {name} came to school on {date} {items}. Kindly send your ward neatly from tomorrow.',
    ta: 'உங்கள் குழந்தை {name}, {date} அன்று {items} பள்ளிக்கு வந்தார். நாளை முதல் ஒழுங்காக அனுப்பவும்.' },
  // Nov 2026: reasons marked in the My Day teacher app
  homework_half: {
    en: 'Your child {name} did not complete the Homework given on {date} in {subject} – {lesson}. Kindly make sure your ward finishes the homework fully.',
    ta: 'உங்கள் குழந்தை {name}, {date} அன்று கொடுத்த {subject} – {lesson} வீட்டுப்பாடத்தை முழுமையாக முடிக்கவில்லை. முழுமையாக எழுத உதவவும்.' },
  homework_notebook: {
    en: 'Your child {name} did not bring the notebook for the {subject} Homework given on {date} ({lesson}). Kindly make sure your ward brings the notebook every day.',
    ta: 'உங்கள் குழந்தை {name}, {date} அன்று கொடுத்த {subject} வீட்டுப்பாட நோட்டைக் கொண்டு வரவில்லை ({lesson}). தினமும் நோட்டைக் கொண்டு வர உதவவும்.' }
};
function fillIn(tpl, v) {
  return String(tpl || '').replace(/\{(name|date|subject|lesson|marks|total|items)\}/g, (m, k) => (v[k] == null ? '' : String(v[k]))).trim();
}
async function loadWording(schoolId) {
  const r = await sb('GET', 'defaulter_wording?school_id=eq.' + enc(schoolId) + '&select=wording&limit=1');
  return (r.ok && r.data && r.data[0] && r.data[0].wording && typeof r.data[0].wording === 'object') ? r.data[0].wording : {};
}
// The school's own words for this message, or null to use the standard words
function ownMessage(W, kind, en, ta) {
  const w = W && W[kind];
  if (!w || (!String(w.en || '').trim() && !String(w.ta || '').trim())) return null;
  const e = fillIn(w.en, en), t = fillIn(w.ta, ta);
  return e && t ? both(e, t) : (e || t);
}
function joinAnd(parts) { return parts.length <= 1 ? parts.join('') : parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1]; }

// ══ Nov 2026: homework defaulters from TeachBot's My Day teacher app ══
const HW_REASON_KIND = { not_done: 'homework', half: 'homework_half', notebook: 'homework_notebook' };
const TB_CLASS_MAP = { 'Pre KG': 'PreKG', 'PRE KG': 'PreKG', 'Pre-KG': 'PreKG' };
function tbKeyOk(given) {
  const want = process.env.TEACHBOT_LINK_KEY || '';
  if (!want || !given) return false;
  const a = Buffer.from(String(given)), b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function rollKey(r) { const t = String(r == null ? '' : r).trim().toLowerCase(); return /^\d+$/.test(t) ? String(parseInt(t, 10)) : t; }
function nameKey(n) { return String(n || '').toLowerCase().replace(/[^a-z\u0B80-\u0BFF]+/g, ' ').trim(); }

async function teachbotDoor(req, res, body) {
  if (!process.env.TEACHBOT_LINK_KEY) return res.status(500).json({ ok: false, error: 'TEACHBOT_LINK_KEY is not set in ERP\'s Vercel settings.' });
  if (!tbKeyOk(req.headers['x-teachbot-key'])) return res.status(401).json({ ok: false, error: 'TeachBot link key does not match ERP\'s TEACHBOT_LINK_KEY.' });
  if (body.action !== 'hw_check' && body.action !== 'class_list') return res.status(400).json({ ok: false, error: 'Unknown action.' });

  const given = clean(body.school_id, 64);
  if (!given || !/^[a-zA-Z0-9_-]+$/.test(given)) return res.status(400).json({ ok: false, error: 'ERP school id missing.' });
  const sch = await sb('GET', 'schools?or=(school_id.eq.' + enc(given) + ',school_code.eq.' + enc(given) + ')&select=school_id&limit=1');
  if (!sch.ok || !sch.data || !sch.data.length) return res.status(404).json({ ok: false, error: 'School ' + given + ' not found in ERP.' });
  const schoolId = String(sch.data[0].school_id);

  // "LKG B" → LKG + section B. No section = section A (or no section saved), like homework.
  let rawCls = clean(body.class_name, 30);
  let sec = clean(body.section, 2).toUpperCase();
  const split = rawCls.match(/^(.*\S)\s+([A-Fa-f])$/);
  if (split) { rawCls = split[1]; if (!sec) sec = split[2].toUpperCase(); }
  if (sec && !/^[A-F]$/.test(sec)) sec = '';
  const cls = TB_CLASS_MAP[rawCls] || rawCls;
  const workDate = String(body.hw_date || '');
  const subject = clean(body.subject, 60);
  const lesson = clean(body.homework, 100) || 'Homework';
  const teacher = clean(body.staff_name, 60) || 'Teacher';
  const marker = 'My Day · ' + teacher;
  if (!cls) return res.status(400).json({ ok: false, error: 'Class missing.' });
  if (body.action === 'class_list') { /* only the class is needed */ }
  else if (!subject) return res.status(400).json({ ok: false, error: 'Subject missing.' });
  else if (!validDate(workDate) || workDate > istToday()) return res.status(400).json({ ok: false, error: 'Homework date missing or in the future.' });

  const kids = (Array.isArray(body.kids) ? body.kids : []).slice(0, 200).map(k => ({
    id: clean(k && k.id, 64), roll: clean(k && k.roll, 10), name: clean(k && k.name, 80),
    reason: HW_REASON_KIND[k && k.reason] ? k.reason : 'not_done'
  })).filter(k => k.id || k.roll || k.name);

  // This class's children in ERP
  let secQ = '';
  if (!sec || sec === 'A') secQ = '&or=(section.eq.A,section.is.null,section.eq.)';
  else secQ = '&section=eq.' + enc(sec);
  const stu = await sb('GET', 'students?school_id=eq.' + enc(schoolId) + '&class=eq.' + enc(cls)
    + '&status=eq.active' + secQ + '&select=id,full_name,roll_no&limit=300');
  if (!stu.ok) return res.status(500).json({ ok: false, error: 'Could not read ERP students: ' + stu.raw });
  if (body.action === 'class_list') {
    const list = (stu.data || []).map(s => ({ id: String(s.id), roll: String(s.roll_no == null ? '' : s.roll_no).trim(), name: clean(s.full_name, 80) }));
    list.sort((a, b) => ((parseInt(a.roll, 10) || 9999) - (parseInt(b.roll, 10) || 9999)) || a.name.localeCompare(b.name));
    return res.status(200).json({ ok: true, rows: list });
  }
  const byId = {};
  (stu.data || []).forEach(s => { byId[String(s.id)] = s; });
  const byRoll = {}, byName = {};
  (stu.data || []).forEach(s => {
    const r = rollKey(s.roll_no);
    if (r) byRoll[r] = byRoll[r] ? 'two' : s;
    const n = nameKey(s.full_name);
    if (n) byName[n] = byName[n] ? 'two' : s;
  });
  const found = [], notFound = [];
  kids.forEach(k => {
    let s = k.id ? byId[k.id] : null;   // exact child when the list came from ERP
    if (!s) s = byRoll[rollKey(k.roll)];
    if (!s || s === 'two') s = byName[nameKey(k.name)];
    if (s && s !== 'two') found.push({ s: s, reason: k.reason });
    else notFound.push((k.roll ? 'Roll ' + k.roll : '') + (k.name ? (k.roll ? ' ' : '') + k.name : ''));
  });

  // Saving again replaces this teacher's waiting entries for this homework; sent ones stay
  const del = await sb('DELETE', 'defaulter_entries?school_id=eq.' + enc(schoolId) + '&kind=eq.homework&status=eq.pending'
    + '&class=eq.' + enc(cls) + '&work_date=eq.' + workDate + '&subject=eq.' + enc(subject)
    + '&marked_by=eq.' + enc(marker) + (sec ? '&section=eq.' + enc(sec) : '&section=is.null'));
  if (!del.ok) return res.status(500).json({ ok: false, error: 'Could not update the list: ' + del.raw });

  if (!found.length) return res.status(200).json({ ok: true, saved: 0, already_sent: 0, not_found: notFound });

  const tamil = await tamilOn(schoolId);
  const W = await loadWording(schoolId);
  const seen = {};
  const rows = [];
  found.forEach(f => {
    const id = String(f.s.id);
    if (seen[id]) return; seen[id] = 1;
    const name = clean(f.s.full_name, 80) || 'your ward';
    const wk = HW_REASON_KIND[f.reason];
    const en = { name: name, date: niceDate(workDate), subject: subject, lesson: lesson };
    const ta = { name: name, date: taDate(workDate), subject: subject, lesson: lesson };
    let message = ownMessage(W, wk, en, ta);
    if (!message) {
      if (wk === 'homework') {
        message = tamil ? both(buildMessage('homework', name, workDate, subject, lesson), defaulterTamil('homework', name, workDate, subject, lesson))
                        : buildMessage('homework', name, workDate, subject, lesson);
      } else {
        const e = fillIn(DEFAULT_WORDING[wk].en, en);
        message = tamil ? both(e, fillIn(DEFAULT_WORDING[wk].ta, ta)) : e;
      }
    }
    rows.push({
      school_id: schoolId, work_date: workDate, kind: 'homework', class: cls, section: sec || null,
      subject: subject, lesson: lesson, student_id: id, student_name: name,
      marks: null, total_marks: null, items: [f.reason], message: message,
      status: 'pending', marked_by: marker
    });
  });
  const ins = await sb('POST', 'defaulter_entries?on_conflict=school_id,student_id,work_date,kind,subject,lesson',
    rows, 'return=representation,resolution=ignore-duplicates');
  if (!ins.ok) return res.status(500).json({ ok: false, error: 'Could not save: ' + ins.raw });
  const saved = (ins.data || []).length;
  return res.status(200).json({ ok: true, saved: saved, already_sent: rows.length - saved, not_found: notFound });
}

// ══ Nov 2026: DAILY CHECK SHEET (printed in TeachBot, photo uploaded by the office) ══
// The teacher puts ✗ on roll numbers; the office uploads a photo; the AI reads the marks; the office
// checks the list beside the photo and saves. Saved entries wait like any other and go at 4 PM.
const SHEET_MODEL = 'claude-sonnet-4-5';
const SHEET_DISC = ['nails', 'notes', 'shoes', 'uniform', 'hair', 'books', 'idcard'];
function splitClass(raw) {
  let cls = clean(raw, 30), sec = '';
  const m = cls.match(/^(.*\S)\s+([A-Fa-f])$/);
  if (m) { cls = m[1]; sec = m[2].toUpperCase(); }
  return { cls: TB_CLASS_MAP[cls] || cls, sec: sec };
}
async function classKids(schoolId, cls, sec) {
  let secQ = '';
  if (!sec || sec === 'A') secQ = '&or=(section.eq.A,section.is.null,section.eq.)';
  else secQ = '&section=eq.' + enc(sec);
  const stu = await sb('GET', 'students?school_id=eq.' + enc(schoolId) + '&class=eq.' + enc(cls)
    + '&status=eq.active' + secQ + '&select=id,full_name,roll_no&limit=300');
  if (!stu.ok) throw new Error('Could not read students: ' + stu.raw);
  const list = (stu.data || []).map(s => ({ id: String(s.id), roll: String(s.roll_no == null ? '' : s.roll_no).trim(), name: clean(s.full_name, 80) }));
  list.sort((a, b) => ((parseInt(a.roll, 10) || 9999) - (parseInt(b.roll, 10) || 9999)) || a.name.localeCompare(b.name));
  return list;
}
function rollsToKids(kids, rolls) {
  const byRoll = {};
  kids.forEach(k => { const r = rollKey(k.roll); if (r) byRoll[r] = byRoll[r] ? 'two' : k; });
  const found = [], unknown = [];
  (Array.isArray(rolls) ? rolls : []).slice(0, 200).forEach(r => {
    const k = byRoll[rollKey(r)];
    if (k && k !== 'two') { if (found.indexOf(k) === -1) found.push(k); }
    else unknown.push(String(r));
  });
  return { found, unknown };
}
async function readSheetPhoto(photoB64, mediaType) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('Photo reading is not set up (ANTHROPIC_API_KEY missing in Vercel).');
  const prompt = 'This is a photo of a printed "Daily Check Sheet" from a school. At the top right there is a code like "DCS·Class 3·2026-11-17" (class and date).\n'
    + 'The sheet has rows. Each row has a small grey code on its right: "HW·<date>·<subject>" (homework), "TEST·<date>·<subject>" (class test, with two lines of boxes: "Not written / not prepared" then "Absent for the test"), or "DISC·<item>" (discipline).\n'
    + 'Each row shows printed roll numbers in boxes. A teacher has put a pen mark (a cross ✗, tick, circle, slash or scribble) on SOME boxes. Find exactly which roll numbers have a pen mark on them. Ignore boxes with no pen mark. Look very carefully at every box; do not guess.\n'
    + 'Homework rows also have "Corrected? ☐ Yes ☐ No" — say which box is ticked, or "blank".\n'
    + 'Reply with ONLY this JSON, nothing else:\n'
    + '{"class":"Class 3","date":"YYYY-MM-DD","rows":[{"code":"HW·2026-11-16·Maths","text":"the printed homework words after the subject","marked":["4","12"],"corrected":"yes|no|blank"},'
    + '{"code":"TEST·2026-11-17·Science","text":"the printed chapter words","not_written":["3"],"absent":["9"]},'
    + '{"code":"DISC·nails","marked":["5"]}],"unclear":"say here if any mark or part of the sheet was hard to read, else empty"}\n'
    + 'Copy every code exactly as printed. Include every row, even if nothing is marked (empty list).';
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: SHEET_MODEL, max_tokens: 3000,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: photoB64 } },
        { type: 'text', text: prompt }] }] })
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Photo reading failed: ' + ((d.error && d.error.message) || ('status ' + r.status)));
  const text = ((d.content || []).find(c => c.type === 'text') || {}).text || '';
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('The photo could not be read. Please take a clearer photo of the whole sheet.');
  try { return JSON.parse(m[0]); } catch (e) { throw new Error('The photo could not be read. Please take a clearer photo of the whole sheet.'); }
}
// "HW·2026-11-16·Maths" → { type:'homework', date, subject }
function parseCode(code) {
  const parts = String(code || '').split(/\s*[·•.|:]\s*/).filter(Boolean);
  const t = (parts[0] || '').toUpperCase();
  if (t === 'HW' && validDate(parts[1] || '')) return { type: 'homework', date: parts[1], subject: clean(parts.slice(2).join(' '), 60) };
  if (t === 'TEST' && validDate(parts[1] || '')) return { type: 'test', date: parts[1], subject: clean(parts.slice(2).join(' '), 60) };
  if (t === 'DISC' && SHEET_DISC.indexOf(String(parts[1] || '').toLowerCase()) !== -1) return { type: 'discipline', code: String(parts[1]).toLowerCase() };
  return null;
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

  // Nov 2026: TeachBot's My Day app (server to server, no staff login)
  if (req.headers['x-teachbot-key'] !== undefined) {
    try { return await teachbotDoor(req, res, body); }
    catch (e) { return res.status(500).json({ ok: false, error: 'Server error: ' + (e.message || e) }); }
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
      // Nov 2026: "homework not done" messages leave the parent app 3 days after they were sent
      const threeDays = Date.now() - 3 * 86400000;
      r.data = (r.data || []).filter(x => x.kind !== 'homework' || new Date(x.sent_at || x.work_date).getTime() >= threeDays);
      // Nov 2026: the home screen shows the newest 5 — note when the parent first saw each one.
      // Only messages not seen before are touched, so the first time stays.
      const shown = (r.data || []).slice(0, 5).map(x => x.id).filter(Boolean);
      if (shown.length) {
        try {
          await sb('PATCH', 'defaulter_entries?school_id=eq.' + enc(String(session.sid))
            + '&student_id=eq.' + enc(String(session.stu))
            + '&seen_at=is.null&id=in.(' + shown.map(enc).join(',') + ')',
            { seen_at: new Date().toISOString() }, 'return=minimal');
        } catch (e) { /* the parent still sees the messages */ }
      }
      // Nov 2026: repeat-defaulter messages (last 14 days) with the "I have seen" button
      let repeats = [];
      try {
        const since14 = new Date(Date.now() - 14 * 86400000).toISOString();
        const rp = await sb('GET', 'defaulter_repeats?school_id=eq.' + enc(String(session.sid))
          + '&student_id=eq.' + enc(String(session.stu)) + '&sent_at=gte.' + enc(since14)
          + '&select=id,kind_group,times,message,sent_at,ack_at&order=sent_at.desc&limit=10');
        if (rp.ok) {
          repeats = rp.data || [];
          const unseen = repeats.filter(x => !x.ack_at).map(x => x.id);
          if (unseen.length) await sb('PATCH', 'defaulter_repeats?school_id=eq.' + enc(String(session.sid))
            + '&student_id=eq.' + enc(String(session.stu)) + '&seen_at=is.null&id=in.(' + unseen.map(enc).join(',') + ')',
            { seen_at: new Date().toISOString() }, 'return=minimal');
        }
      } catch (e) { /* the other messages still show */ }
      return res.status(200).json({ ok: true, rows: r.data || [], repeats: repeats });
    }

    // Nov 2026: the parent taps "I have seen" on a repeat-defaulter message
    if (action === 'ack_repeat') {
      if (!isParent(session)) return res.status(403).json({ ok: false, error: 'Parents only.' });
      const id = String(body.id || '');
      if (!/^[0-9a-fA-F-]{36}$/.test(id)) return res.status(400).json({ ok: false, error: 'Message missing.' });
      const now = new Date().toISOString();
      const r = await sb('PATCH', 'defaulter_repeats?id=eq.' + enc(id) + '&school_id=eq.' + enc(String(session.sid))
        + '&student_id=eq.' + enc(String(session.stu)) + '&ack_at=is.null', { ack_at: now, seen_at: now });
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Could not save. Please try again.' });
      return res.status(200).json({ ok: true, ack_at: now });
    }

    // The school always comes from the login, never from the browser.
    if (!canMark(session)) return res.status(401).json({ ok: false, error: 'Please log in again.' });
    const schoolId = String(session.sid);

    // ══ Nov 2026: DAILY CHECK SHEET — read a photo, then save what the office checked ══
    if (action === 'read_sheet') {
      const photo = String(body.photo || '').replace(/^data:image\/\w+;base64,/, '');
      const mediaType = /^image\/(jpeg|png|webp)$/.test(String(body.media_type || '')) ? body.media_type : 'image/jpeg';
      if (!photo || photo.length < 1000) return res.status(400).json({ ok: false, error: 'Please choose a photo of the sheet.' });
      if (photo.length > 6000000) return res.status(400).json({ ok: false, error: 'The photo is too big. Please try again.' });
      let read;
      try { read = await readSheetPhoto(photo, mediaType); }
      catch (e) { return res.status(200).json({ ok: false, error: e.message }); }
      const label = clean(body.class_label || read.class, 30);
      const sheetDate = validDate(String(body.sheet_date || '')) ? body.sheet_date : (validDate(String(read.date || '')) ? read.date : istToday());
      const sc = splitClass(label);
      let kids = [];
      try { kids = sc.cls ? await classKids(schoolId, sc.cls, sc.sec) : []; }
      catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
      const lines = [];
      (Array.isArray(read.rows) ? read.rows : []).slice(0, 30).forEach(row => {
        const p = parseCode(row && row.code);
        if (!p) return;
        const mk = (type, rolls, extra) => {
          const m = rollsToKids(kids, rolls);
          lines.push(Object.assign({ type: type, rolls: m.found.map(k => k.roll), unknown: m.unknown }, extra));
        };
        if (p.type === 'homework') mk('homework', row.marked, { subject: p.subject, date: p.date, lesson: clean(row.text, 100),
          corrected: row.corrected === 'yes' ? 'yes' : row.corrected === 'no' ? 'no' : '' });
        else if (p.type === 'test') {
          mk('test_not_written', row.not_written, { subject: p.subject, date: p.date, lesson: clean(row.text, 100) });
          mk('test_absent', row.absent, { subject: p.subject, date: p.date, lesson: clean(row.text, 100) });
        } else mk('discipline', row.marked, { code: p.code, label: (DISCIPLINE[p.code] || [p.code])[0], date: sheetDate });
      });
      if (!lines.length) return res.status(200).json({ ok: false, error: 'No rows of a Daily Check Sheet were found in this photo. Please take the photo again, with the whole sheet flat and in good light.' });
      return res.status(200).json({ ok: true, class_label: label, erp_class: sc.cls, section: sc.sec, sheet_date: sheetDate,
        unclear: clean(read.unclear, 300), kids: kids, lines: lines, class_found: kids.length > 0 });
    }

    if (action === 'students_for_sheet') {
      const sc = splitClass(body.class_label);
      if (!sc.cls) return res.status(400).json({ ok: false, error: 'Type the class.' });
      return res.status(200).json({ ok: true, kids: await classKids(schoolId, sc.cls, sc.sec) });
    }

    if (action === 'save_sheet') {
      const sc = splitClass(body.class_label);
      const sheetDate = String(body.sheet_date || '');
      if (!sc.cls) return res.status(400).json({ ok: false, error: 'The class is missing.' });
      if (!validDate(sheetDate) || sheetDate > istToday()) return res.status(400).json({ ok: false, error: 'The sheet date is missing or in the future.' });
      const staffName = clean(body.staff_name, 80) || (session.role === 'staff' ? 'Office' : 'Admin');
      const marker = 'Check sheet · ' + staffName;
      const kids = await classKids(schoolId, sc.cls, sc.sec);
      if (!kids.length) return res.status(400).json({ ok: false, error: 'No students found in ' + clean(body.class_label, 30) + ' in ERP.' });
      const tamil = await tamilOn(schoolId);
      const W = await loadWording(schoolId);
      const lines = (Array.isArray(body.lines) ? body.lines : []).slice(0, 40);
      const rows = [], disc = {}, corrections = [];
      let skipped = 0;
      lines.forEach(l => {
        const type = String(l && l.type || '');
        const m = rollsToKids(kids, l && l.rolls);
        if (type === 'discipline') {
          const code = String(l.code || '');
          if (DISCIPLINE_CODES.indexOf(code) === -1) return;
          m.found.forEach(k => { (disc[k.id] = disc[k.id] || { k: k, codes: [] }).codes.push(code); });
          return;
        }
        if (['homework', 'test_not_written', 'test_absent'].indexOf(type) === -1) return;
        const subject = clean(l.subject, 60), workDate = String(l.date || '');
        if (!subject || !validDate(workDate) || workDate > istToday()) { skipped++; return; }
        const lesson = clean(l.lesson, 100) || (type === 'homework' ? 'Homework' : 'Class test');
        if (type === 'homework' && (l.corrected === 'yes' || l.corrected === 'no' || m.found.length)) {
          corrections.push({ school_id: schoolId, class: sc.cls, section: sc.sec || '', hw_date: workDate, subject: subject,
            teacher: clean(l.teacher, 60) || null, corrected: l.corrected === 'yes' ? true : l.corrected === 'no' ? false : null,
            checked_on: sheetDate, marked_by: staffName, updated_at: new Date().toISOString() });
        }
        m.found.forEach(k => {
          const name = k.name || 'your ward';
          const en = { name: name, date: niceDate(workDate), subject: subject, lesson: lesson };
          const ta = { name: name, date: taDate(workDate), subject: subject, lesson: lesson };
          const message = ownMessage(W, type, en, ta) || (tamil
            ? both(buildMessage(type, name, workDate, subject, lesson), defaulterTamil(type, name, workDate, subject, lesson))
            : buildMessage(type, name, workDate, subject, lesson));
          rows.push({ school_id: schoolId, work_date: workDate, kind: type, class: sc.cls, section: sc.sec || null,
            subject: subject, lesson: lesson, student_id: k.id, student_name: name, marks: null, total_marks: null,
            items: type === 'homework' ? ['not_done'] : null, message: message, status: 'pending', marked_by: marker });
        });
      });
      let saved = 0, already = 0;
      if (rows.length) {
        const ins = await sb('POST', 'defaulter_entries?on_conflict=school_id,student_id,work_date,kind,subject,lesson',
          rows, 'return=representation,resolution=ignore-duplicates');
        if (!ins.ok) return res.status(500).json({ ok: false, error: 'Could not save: ' + ins.raw });
        saved = (ins.data || []).length; already = rows.length - saved;
      }
      // Discipline: one combined message per child per day (adds to a waiting one, like the Mark tab)
      const dIds = Object.keys(disc);
      let dSaved = 0;
      if (dIds.length) {
        const old = await sb('GET', 'defaulter_entries?school_id=eq.' + enc(schoolId) + '&kind=eq.discipline&work_date=eq.' + sheetDate
          + '&student_id=in.(' + dIds.map(enc).join(',') + ')&select=id,student_id,status,items');
        const oldBy = {};
        if (old.ok) (old.data || []).forEach(o => { oldBy[String(o.student_id)] = o; });
        for (const id of dIds) {
          const d = disc[id], o = oldBy[id];
          if (o && o.status !== 'pending') { already++; continue; }
          const name = d.k.name || 'your ward';
          const codes = [...new Set((o && Array.isArray(o.items) ? o.items : []).concat(d.codes))];
          const dl = DISCIPLINE_CODES.filter(c => codes.indexOf(c) !== -1);
          const message = ownMessage(W, 'discipline',
              { name: name, date: niceDate(sheetDate), items: joinAnd(dl.map(c => DISCIPLINE[c][1])) },
              { name: name, date: taDate(sheetDate), items: dl.map(c => DISCIPLINE[c][2]).join(', ') })
            || disciplineMessage(name, sheetDate, niceDate(sheetDate), codes, tamil);
          const w = o
            ? await sb('PATCH', 'defaulter_entries?id=eq.' + enc(o.id) + '&school_id=eq.' + enc(schoolId) + '&status=eq.pending',
                { items: codes, message: message, marked_by: marker })
            : await sb('POST', 'defaulter_entries', [{ school_id: schoolId, work_date: sheetDate, kind: 'discipline', class: sc.cls,
                section: sc.sec || null, subject: 'Discipline', lesson: 'Discipline', student_id: id, student_name: name,
                marks: null, total_marks: null, items: codes, message: message, status: 'pending', marked_by: marker }]);
          if (!w.ok) return res.status(500).json({ ok: false, error: 'Could not save discipline: ' + w.raw });
          dSaved++;
        }
      }
      let corrNote = '';
      if (corrections.length) {
        const cw = await sb('POST', 'homework_corrections?on_conflict=school_id,class,section,hw_date,subject', corrections, 'return=minimal,resolution=merge-duplicates');
        if (!cw.ok) corrNote = /homework_corrections/.test(cw.raw || '') ? 'Corrected Yes / No was not kept: please run step-check-sheet.sql in Supabase.' : 'Corrected Yes / No was not kept: ' + cw.raw;
      }
      return res.status(200).json({ ok: true, saved: saved + dSaved, already: already, skipped: skipped,
        not_corrected: corrections.filter(c => c.corrected === false).length, note: corrNote });
    }

    // ══ Nov 2026: message wording (everyone who marks can see it; principal / admin can change it) ══
    if (action === 'wording_get') {
      const r = await sb('GET', 'defaulter_wording?school_id=eq.' + enc(schoolId) + '&select=wording&limit=1');
      return res.status(200).json({ ok: true, defaults: DEFAULT_WORDING, saved: (r.ok && r.data && r.data[0] && r.data[0].wording) || {},
        ready: r.ok, tamil_on: await tamilOn(schoolId), can_edit: session.role !== 'staff' });
    }
    if (action === 'wording_save') {
      if (session.role === 'staff') return res.status(403).json({ ok: false, error: 'Only the principal or admin can change the wording.' });
      const given = body.wording && typeof body.wording === 'object' ? body.wording : {};
      const out = {};
      WORDING_KINDS.forEach(k => {
        const g = given[k] || {};
        const en = String(g.en || '').replace(/\s+/g, ' ').trim().slice(0, 600);
        const ta = String(g.ta || '').replace(/\s+/g, ' ').trim().slice(0, 600);
        if (en || ta) out[k] = { en: en, ta: ta };
      });
      const r = await sb('POST', 'defaulter_wording?on_conflict=school_id',
        [{ school_id: schoolId, wording: out, updated_at: new Date().toISOString(), updated_by: clean(body.staff_name, 80) || 'Admin' }],
        'return=representation,resolution=merge-duplicates');
      if (!r.ok) return res.status(500).json({ ok: false, error: /defaulter_wording/.test(r.raw || '')
        ? 'The database is not ready for this yet. Please run step-defaulter-wording.sql in Supabase first.' : 'Could not save: ' + r.raw });
      return res.status(200).json({ ok: true, saved: out });
    }

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
      const tamil = await tamilOn(schoolId);
      const W = await loadWording(schoolId);   // Nov 2026: the school's own words, if any

      // ── Discipline: one combined message per child per day ──
      if (kind === 'discipline') {
        if (!validDate(workDate)) return res.status(400).json({ ok: false, error: 'Please pick the date.' });
        if (workDate > istToday()) return res.status(400).json({ ok: false, error: 'The date cannot be in the future.' });
        if (!cls) return res.status(400).json({ ok: false, error: 'Please pick a class.' });
        const given = body.items && typeof body.items === 'object' ? body.items : {};
        const want = {};
        Object.keys(given).slice(0, 200).forEach(id => {
          const codes = (Array.isArray(given[id]) ? given[id] : []).map(String).filter(c => DISCIPLINE_CODES.indexOf(c) !== -1);
          if (codes.length) want[String(id)] = [...new Set(codes)];
        });
        const ids = Object.keys(want);
        if (ids.length === 0) return res.status(200).json({ ok: true, saved: 0, note: 'No item was ticked.' });

        const stu = await sb('GET', 'students?school_id=eq.' + enc(schoolId) + '&class=eq.' + enc(cls)
          + '&id=in.(' + ids.map(enc).join(',') + ')&select=id,full_name');
        if (!stu.ok) return res.status(500).json({ ok: false, error: 'Could not check students: ' + stu.raw });

        // Today's discipline notes already there for these children
        const old = await sb('GET', 'defaulter_entries?school_id=eq.' + enc(schoolId) + '&kind=eq.discipline&work_date=eq.' + workDate
          + '&student_id=in.(' + ids.map(enc).join(',') + ')&select=id,student_id,status,items');
        if (!old.ok) {
          const needSql = /items/.test(old.raw || '');
          return res.status(500).json({ ok: false, error: needSql
            ? 'The database is not ready for discipline notes yet. Please run the discipline SQL step in Supabase first.'
            : 'Could not check: ' + old.raw });
        }
        const oldBy = {};
        (old.data || []).forEach(o => { oldBy[String(o.student_id)] = o; });

        let saved = 0, alreadySent = 0;
        for (const s of (stu.data || [])) {
          const id = String(s.id);
          const name = clean(s.full_name, 80) || 'your ward';
          const o = oldBy[id];
          if (o && o.status !== 'pending') { alreadySent++; continue; }
          const codes = [...new Set((o && Array.isArray(o.items) ? o.items : []).concat(want[id]))];
          const dl = DISCIPLINE_CODES.filter(c => codes.indexOf(c) !== -1);
          const message = ownMessage(W, 'discipline',
              { name: name, date: niceDate(workDate), items: joinAnd(dl.map(c => DISCIPLINE[c][1])) },
              { name: name, date: taDate(workDate), items: dl.map(c => DISCIPLINE[c][2]).join(', ') })
            || disciplineMessage(name, workDate, niceDate(workDate), codes, tamil);
          if (o) {
            const u = await sb('PATCH', 'defaulter_entries?id=eq.' + enc(o.id) + '&school_id=eq.' + enc(schoolId) + '&status=eq.pending',
              { items: codes, message: message, marked_by: staffName });
            if (!u.ok) return res.status(500).json({ ok: false, error: 'Could not save: ' + u.raw });
          } else {
            const ins = await sb('POST', 'defaulter_entries', [{
              school_id: schoolId, work_date: workDate, kind: 'discipline', class: cls, section: sec,
              subject: 'Discipline', lesson: 'Discipline', student_id: id, student_name: name,
              marks: null, total_marks: null, items: codes, message: message,
              status: 'pending', marked_by: staffName
            }]);
            if (!ins.ok) {
              const needSql = /items|kind|check/i.test(ins.raw || '');
              return res.status(500).json({ ok: false, error: needSql
                ? 'The database is not ready for discipline notes yet. Please run the discipline SQL step in Supabase first.'
                : 'Could not save: ' + ins.raw });
            }
          }
          saved++;
        }
        if (saved === 0 && alreadySent === 0) return res.status(400).json({ ok: false, error: 'Those students are not in this class.' });
        return res.status(200).json({ ok: true, saved: saved, already: 0, already_sent: alreadySent });
      }

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
          message: ownMessage(W, kind,
              { name: name, date: niceDate(workDate), subject: subject, lesson: lesson, marks: scoreOf[id], total: total },
              { name: name, date: taDate(workDate), subject: subject, lesson: lesson, marks: scoreOf[id], total: total }) || (tamil
            ? both(buildMessage(kind, name, workDate, subject, lesson, scoreOf[id], total),
                   defaulterTamil(kind, name, workDate, subject, lesson, scoreOf[id], total))
            : buildMessage(kind, name, workDate, subject, lesson, scoreOf[id], total)),
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
    if (['pending', 'send', 'repeat', 'seen_list'].indexOf(action) !== -1 && !canSend(session)) {
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
          homework: 0, test_not_written: 0, test_absent: 0, test_low_marks: 0, discipline: 0, total: 0 };
        byChild[k][e.kind] = (byChild[k][e.kind] || 0) + 1;
        byChild[k].total++;
      }
      const rows = Object.values(byChild).sort((a, b) => b.total - a.total);
      return res.status(200).json({ ok: true, month: month, rows: rows });
    }

    // ══ Nov 2026: repeat defaulters — parents who must tap "I have seen"; the office calls those who don't ══
    if (action === 'repeats_list' || action === 'repeat_called') {
      if (!canSend(session)) return res.status(403).json({ ok: false, error: 'Only the office can see this.' });
      if (action === 'repeat_called') {
        const id = String(body.id || '');
        if (!/^[0-9a-fA-F-]{36}$/.test(id)) return res.status(400).json({ ok: false, error: 'Entry missing.' });
        const r = await sb('PATCH', 'defaulter_repeats?id=eq.' + enc(id) + '&school_id=eq.' + enc(schoolId),
          { called_at: new Date().toISOString(), called_by: clean(body.staff_name, 80) || 'Office' });
        if (!r.ok) return res.status(500).json({ ok: false, error: 'Could not save: ' + r.raw });
        return res.status(200).json({ ok: true });
      }
      const since = new Date(Date.now() - 30 * 86400000).toISOString();
      const r = await sb('GET', 'defaulter_repeats?school_id=eq.' + enc(schoolId) + '&sent_at=gte.' + enc(since)
        + '&select=*&order=sent_at.desc&limit=1000');
      if (!r.ok) return res.status(500).json({ ok: false, error: /defaulter_repeats/.test(r.raw || '')
        ? 'The database is not ready for this yet. Please run step-check-sheet.sql in Supabase first.' : 'Could not load: ' + r.raw });
      const rows = r.data || [];
      const ids = [...new Set(rows.map(x => String(x.student_id)))];
      const phone = {};
      for (let i = 0; i < ids.length; i += 150) {
        const s = await sb('GET', 'students?school_id=eq.' + enc(schoolId) + '&id=in.(' + ids.slice(i, i + 150).map(enc).join(',') + ')&select=id,mobile');
        if (s.ok) (s.data || []).forEach(x => { phone[String(x.id)] = x.mobile || ''; });
      }
      rows.forEach(x => { x.mobile = phone[String(x.student_id)] || ''; });
      return res.status(200).json({ ok: true, rows: rows });
    }

    // ══ Nov 2026: Seen / Not seen — messages sent on one day, and whether the parent saw each ══
    if (action === 'seen_list') {
      const day = validDate(body.date || '') ? body.date : istToday();
      const next = new Date(new Date(day + 'T00:00:00Z').getTime() + 86400000).toISOString().slice(0, 10);
      const r = await sb('GET', 'defaulter_entries?school_id=eq.' + enc(schoolId)
        + '&status=eq.sent&sent_at=gte.' + enc(day + 'T00:00:00+05:30') + '&sent_at=lt.' + enc(next + 'T00:00:00+05:30')
        + '&select=id,student_id,student_name,class,section,kind,subject,work_date,sent_at,seen_at'
        + '&order=class.asc,student_name.asc&limit=2000');
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Could not load the list. Has step-parent-seen.sql been run? ' + r.raw });
      const rows = r.data || [];
      // Parents' phone numbers, so the office can call those who have not seen it
      const ids = [...new Set(rows.map(x => String(x.student_id)).filter(Boolean))];
      const phone = {};
      for (let i = 0; i < ids.length; i += 150) {
        const s = await sb('GET', 'students?school_id=eq.' + enc(schoolId)
          + '&id=in.(' + ids.slice(i, i + 150).map(enc).join(',') + ')&select=id,mobile');
        if (s.ok) (s.data || []).forEach(x => { phone[String(x.id)] = x.mobile || ''; });
      }
      rows.forEach(x => { x.mobile = phone[String(x.student_id)] || ''; });
      return res.status(200).json({ ok: true, date: day, rows: rows });
    }

    return res.status(400).json({ ok: false, error: 'Unknown action.' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'Server error: ' + (e.message || e) });
  }
};
