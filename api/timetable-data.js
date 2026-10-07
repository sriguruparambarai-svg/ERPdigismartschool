// DigiSmart ERP — Timetable Data API
// The ONLY door for reading and saving a school's timetable settings
// (period times, subjects, working days, teacher map) and, from step 2,
// the master timetable (periods x classes, one grid per weekday).
// Verifies the signed session token from login, allows only owners and
// staff with the I-Card/Timetable module, and locks every read/write to the
// token holder's own school. Uses the server-side service key.
//
// POST { token, action: 'get_settings' }
//   → { ok: true, settings: {...} | null }
// POST { token, action: 'save_settings', settings: { periods, subjects, working_days, teacher_map } }
//   → { ok: true, settings: {...} }
// POST { token, action: 'get_master', academic_year }
//   → { ok: true, master: {...} | null }
// POST { token, action: 'save_master', academic_year, classes, grid }
//   → { ok: true, master: {...} }
// POST { token, action: 'send_to_classes', academic_year }
//   → { ok: true, sent: [class names], skipped: [class names with no periods] }
//   Copies the SAVED master into each class's own timetable (all its sections).

const crypto = require('crypto');

const SUPABASE_URL = 'https://nkfxrbumhjztmdyepygt.supabase.co';
const SETTINGS_TABLE = 'tt_settings';
const MASTER_TABLE = 'tt_master';
const CLASS_TT_TABLE = 'timetables';
// Same colours, in the same order, as the Subject Palette on the Timetable page
const SUBJECT_COLORS = ['#6B1A1A','#185FA5','#0F6E56','#854F0B','#4A1070','#8B2A2A','#0C447C','#085041','#633806','#3C3489'];

function getServiceKey() {
  return process.env.SUPABASE_SERVICE_KEY
      || process.env.SUPABASE_SERVICE_ROLE_KEY
      || '';
}

// ── Verify the signed session token issued at login ──
function verifySessionToken(token) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 2) return null;
    const payload = Buffer.from(parts[0], 'base64').toString('utf8');
    const sig = crypto.createHmac('sha256', getServiceKey()).update(payload).digest('hex');
    if (sig !== parts[1]) return null;
    const d = JSON.parse(payload);
    if (Date.now() > d.exp) return null;
    return d; // { sid, role, mods, exp }
  } catch (e) { return null; }
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
  if (!r.ok) throw new Error((data && data.message) || ('Database error ' + r.status + ': ' + text.slice(0, 200)));
  return data;
}

// ── Cleaning: keep only the shapes we expect, trimmed to safe sizes ──
function str(v, max) { return String(v == null ? '' : v).slice(0, max); }

function cleanPeriods(list) {
  if (!Array.isArray(list)) return null;
  return list.slice(0, 20).map(p => ({
    label: str(p && p.label, 40),
    start: str(p && p.start, 5),
    end: str(p && p.end, 5),
    isBreak: !!(p && p.isBreak)
  }));
}

function cleanStringList(list, maxItems, maxLen) {
  if (!Array.isArray(list)) return null;
  return list.slice(0, maxItems).map(s => str(s, maxLen)).filter(s => s.trim() !== '');
}

function cleanTeacherMap(map) {
  if (!map || typeof map !== 'object' || Array.isArray(map)) return null;
  const out = {};
  Object.keys(map).slice(0, 200).forEach(k => { out[str(k, 80)] = str(map[k], 120); });
  return out;
}

function cleanSettings(input) {
  const s = (input && typeof input === 'object') ? input : {};
  const out = {};
  const periods = cleanPeriods(s.periods);
  if (periods) out.periods = periods;
  const subjects = cleanStringList(s.subjects, 60, 60);
  if (subjects) out.subjects = subjects;
  const days = cleanStringList(s.working_days, 7, 12);
  if (days) out.working_days = days;
  const tmap = cleanTeacherMap(s.teacher_map);
  if (tmap) out.teacher_map = tmap;
  return out;
}

// Master grid: { Monday: { "0": { "Class 1": { teacher, subject } } } }
function cleanMasterGrid(grid) {
  const out = {};
  if (!grid || typeof grid !== 'object' || Array.isArray(grid)) return out;
  Object.keys(grid).slice(0, 7).forEach(day => {
    const dayObj = grid[day];
    if (!dayObj || typeof dayObj !== 'object') return;
    const d = {};
    Object.keys(dayObj).slice(0, 20).forEach(pi => {
      const row = dayObj[pi];
      if (!row || typeof row !== 'object') return;
      const r = {};
      Object.keys(row).slice(0, 30).forEach(cls => {
        const cell = row[cls];
        if (!cell || typeof cell !== 'object') return;
        const teacher = str(cell.teacher, 120);
        const subject = str(cell.subject, 60);
        if (teacher || subject) {
          r[str(cls, 30)] = { teacher, subject };
          if (cell.common === true) r[str(cls, 30)].common = true;   // Common class (combined classes, one teacher)
        }
      });
      if (Object.keys(r).length) d[str(pi, 3)] = r;
    });
    out[str(day, 12)] = d;
  });
  return out;
}

async function upsertBySchool(table, schoolId, extraFilter, row) {
  const enc = encodeURIComponent;
  const filter = 'school_id=eq.' + enc(schoolId) + (extraFilter || '');
  const existing = (await sb('GET', table + '?' + filter + '&select=id&limit=1')) || [];
  let saved;
  if (existing.length) {
    saved = await sb('PATCH', table + '?' + filter, row);
  } else {
    saved = await sb('POST', table, Object.assign({ school_id: schoolId }, row));
  }
  return (saved || [])[0] || null;
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

  // ── 1. Identity check ──
  const session = verifySessionToken(body.token);
  if (!session) {
    return res.status(401).json({ ok: false, error: 'Session expired. Please log in again.' });
  }
  const isOwner = session.role === 'owner';
  const hasModule = Array.isArray(session.mods) && session.mods.indexOf('icard') !== -1;
  if (!isOwner && !hasModule) {
    return res.status(403).json({ ok: false, error: 'You do not have permission for the Timetable.' });
  }
  const schoolId = String(session.sid || '');
  if (!schoolId || !/^[a-zA-Z0-9_-]+$/.test(schoolId)) {
    return res.status(401).json({ ok: false, error: 'Invalid session. Please log in again.' });
  }

  const action = String(body.action || '');
  const enc = encodeURIComponent;

  try {
    // ── 2. Timetable settings ──
    if (action === 'get_settings') {
      const rows = (await sb('GET', SETTINGS_TABLE + '?school_id=eq.' + enc(schoolId) + '&select=*&limit=1')) || [];
      return res.status(200).json({ ok: true, settings: rows[0] || null });
    }

    if (action === 'save_settings') {
      const fields = cleanSettings(body.settings);
      if (!Object.keys(fields).length) {
        return res.status(400).json({ ok: false, error: 'Nothing to save.' });
      }
      const saved = await upsertBySchool(SETTINGS_TABLE, schoolId, '', fields);
      return res.status(200).json({ ok: true, settings: saved });
    }

    // ── 3. Master timetable (used from step 2) ──
    const year = str(body.academic_year, 12);
    if (action === 'get_master') {
      if (!year) return res.status(400).json({ ok: false, error: 'Academic year missing.' });
      const rows = (await sb('GET', MASTER_TABLE + '?school_id=eq.' + enc(schoolId) +
        '&academic_year=eq.' + enc(year) + '&select=*&limit=1')) || [];
      return res.status(200).json({ ok: true, master: rows[0] || null });
    }

    if (action === 'save_master') {
      if (!year) return res.status(400).json({ ok: false, error: 'Academic year missing.' });
      const classes = cleanStringList(body.classes, 30, 30) || [];
      const grid = cleanMasterGrid(body.grid);
      const saved = await upsertBySchool(MASTER_TABLE, schoolId, '&academic_year=eq.' + enc(year), {
        academic_year: year, classes, grid, updated_at: new Date().toISOString()
      });
      return res.status(200).json({ ok: true, master: saved });
    }

    // ── 4. Send the saved master to the class timetables ──
    if (action === 'send_to_classes') {
      if (!year) return res.status(400).json({ ok: false, error: 'Academic year missing.' });
      const mrows = (await sb('GET', MASTER_TABLE + '?school_id=eq.' + enc(schoolId) +
        '&academic_year=eq.' + enc(year) + '&select=*&limit=1')) || [];
      const master = mrows[0];
      if (!master) return res.status(400).json({ ok: false, error: 'No saved master timetable for ' + year + '. Please press Save Master first.' });

      const srows = (await sb('GET', SETTINGS_TABLE + '?school_id=eq.' + enc(schoolId) + '&select=subjects&limit=1')) || [];
      const subjects = (srows[0] && Array.isArray(srows[0].subjects)) ? srows[0].subjects : [];
      const colorFor = s => {
        const i = subjects.indexOf(s);
        return SUBJECT_COLORS[(i === -1 ? 0 : i) % SUBJECT_COLORS.length];
      };

      const classes = Array.isArray(master.classes) ? master.classes : [];
      const grid = (master.grid && typeof master.grid === 'object') ? master.grid : {};
      const sent = [], skipped = [];

      for (const cls of classes) {
        // Build this class's grid: key "Monday_0" → { subject, teacher, color }
        const out = {};
        Object.keys(grid).forEach(day => {
          const dayObj = grid[day] || {};
          Object.keys(dayObj).forEach(pi => {
            const cell = dayObj[pi] && dayObj[pi][cls];
            if (!cell || (!cell.subject && !cell.teacher)) return;
            out[day + '_' + pi] = {
              subject: cell.subject || '',
              teacher: cell.teacher || null,
              color: colorFor(cell.subject || '')
            };
          });
        });
        // A class with nothing in the master is left untouched, never wiped
        if (!Object.keys(out).length) { skipped.push(cls); continue; }

        const filter = 'school_id=eq.' + enc(schoolId) + '&class=eq.' + enc(cls) + '&academic_year=eq.' + enc(year);
        const existing = (await sb('GET', CLASS_TT_TABLE + '?' + filter + '&select=id,section')) || [];
        // One column per class → every section of this class gets the same timetable
        if (existing.length) await sb('PATCH', CLASS_TT_TABLE + '?' + filter, { grid: out });
        if (!existing.some(r => (r.section || '') === '')) {
          await sb('POST', CLASS_TT_TABLE, { school_id: schoolId, class: cls, section: '', academic_year: year, grid: out });
        }
        sent.push(cls);
      }
      return res.status(200).json({ ok: true, sent, skipped });
    }
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'Could not complete the timetable request. ' + String(e.message || e).slice(0, 200) });
  }

  return res.status(400).json({ ok: false, error: 'Unknown action.' });
};
