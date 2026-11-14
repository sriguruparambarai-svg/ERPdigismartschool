// DigiSmart ERP — Substitute teachers on autopilot (Nov 2026)
// Every school morning at 9:30 AM the ERP checks which teachers are absent today
// (marked absent, on approved staff leave, or not checked in while others have),
// takes their periods from the master timetable, finds who is free in each of
// those periods, and tells the owner in the Owner App — one alert with every
// absent teacher's periods and 1–3 suggested free teachers for each.
// Free = present today, no class (and not helping a class) in that period;
// teachers with fewer periods today are suggested first.
// Only schools with a master timetable and at least one Owner App person. Nothing
// is sent when every teacher is present.
//
// GET /api/substitutes                    (Vercel cron 04:00 UTC = 9:30 AM IST, Bearer CRON_SECRET)
// GET /api/substitutes?key=…&school=…&dry=1&date=YYYY-MM-DD   → test run, nothing saved or sent
// POST { token (owner / staff), action: 'today' } → today's suggestion (for the ERP, any time)

const crypto = require('crypto');
const { sb, enc, getServiceKey, sendToSubs, pushReady } = require('./_push');

const BASE = 'https://erp.digismartschool.com';
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MAX_SUGGEST = 3;

function istTodayIso() { return new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10); }
function norm(n) { return String(n || '').toLowerCase().replace(/^(mr|mrs|ms|miss|dr)\.?\s+/, '').replace(/[^a-z0-9]/g, ''); }
async function safe(p, fallback) { try { return await p; } catch (e) { return fallback; } }
function parseJson(v, fb) { if (v == null) return fb; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch (e) { return fb; } }

// The grid teachers actually follow: the copy sent to staff, else the saved master
async function loadTimetable(schoolId) {
  const m = (await safe(sb('GET', 'tt_master?school_id=eq.' + enc(schoolId) +
    '&select=academic_year,grid,staff_grid,staff_sent_at,updated_at&order=updated_at.desc&limit=1'), []) || [])[0];
  if (!m) return null;
  const grid = parseJson(m.staff_sent_at && m.staff_grid ? m.staff_grid : m.grid, null);
  if (!grid) return null;
  const st = (await safe(sb('GET', 'tt_settings?school_id=eq.' + enc(schoolId) + '&select=periods,working_days&limit=1'), []) || [])[0] || {};
  return { grid, periods: parseJson(st.periods, []) || [] };
}

function dayGrid(grid, day) {
  const name = DAY_NAMES[new Date(day + 'T00:00:00Z').getUTCDay()];
  return grid[name] || grid[name.slice(0, 3)] || grid[name.toLowerCase()] || null;
}

async function plan(schoolId, day) {
  const tt = await loadTimetable(schoolId);
  if (!tt) return { reason: 'no master timetable' };
  const g = dayGrid(tt.grid, day);
  if (!g) return { reason: 'no periods on this weekday' };

  // Who teaches what today
  const busy = {};       // norm(teacher) → Set of period indexes
  const load = {};       // norm(teacher) → number of periods today
  const display = {};    // norm(teacher) → name as written
  const slots = {};      // norm(teacher) → [{ pi, cls, subject }]
  Object.keys(g).forEach(pi => {
    const row = g[pi] || {};
    Object.keys(row).forEach(cls => {
      const c = row[cls] || {};
      [c.teacher, c.helper].forEach((t, i) => {
        const k = norm(t);
        if (!k) return;
        display[k] = display[k] || String(t).trim();
        (busy[k] = busy[k] || new Set()).add(String(pi));
        if (i === 0) {
          load[k] = (load[k] || 0) + 1;
          (slots[k] = slots[k] || []).push({ pi: String(pi), cls, subject: c.subject || '' });
        }
      });
    });
  });

  // Today's staff attendance and staff leave
  const staff = await safe(sb('GET', 'staff?school_id=eq.' + enc(schoolId) + '&status=eq.active&select=id,name,role,mobile&limit=1000'), []) || [];
  const att = await safe(sb('GET', 'staff_attendance?school_id=eq.' + enc(schoolId) + '&date=eq.' + day + '&select=staff_id,staff_name,status&limit=1000'), []) || [];
  const leaves = await safe(sb('GET', 'staff_leaves?school_id=eq.' + enc(schoolId) + '&status=eq.approved&from_date=lte.' + day +
    '&to_date=gte.' + day + '&select=staff_id,staff_name,leave_type&limit=500'), []) || [];
  const attUsed = att.some(a => a.status === 'present' || a.status === 'late');

  const byKey = {};
  staff.forEach(s => { const k = norm(s.name); if (k) byKey[k] = s; });
  const status = {};     // norm(name) → 'present' | 'absent' | 'leave' | 'not_in'
  att.forEach(a => {
    const s = staff.find(x => String(x.id) === String(a.staff_id));
    const k = norm((s && s.name) || a.staff_name);
    if (k) status[k] = a.status === 'absent' ? 'absent' : 'present';
  });
  const leaveType = {};
  leaves.forEach(l => {
    const s = staff.find(x => String(x.id) === String(l.staff_id));
    const k = norm((s && s.name) || l.staff_name);
    if (k) { status[k] = 'leave'; leaveType[k] = l.leave_type || ''; }
  });

  // Teachers with periods today who are not here
  const absent = [];
  Object.keys(slots).forEach(k => {
    let st = status[k];
    if (!st) st = attUsed ? 'not_in' : 'present';   // school not using staff attendance today → assume present
    if (st === 'present') return;
    absent.push({ key: k, name: display[k], status: st, leave_type: leaveType[k] || '', mobile: (byKey[k] && byKey[k].mobile) || '' });
  });
  if (!absent.length) return { absent: [], att_used: attUsed };

  const isHere = k => {
    const st = status[k] || (attUsed ? 'not_in' : 'present');
    return st === 'present';
  };
  // Everyone who could cover: teachers in today's timetable + teaching staff in the staff list
  const pool = new Set(Object.keys(display));
  // (non-teaching staff — drivers, ayahs, office, security… — are never suggested)
  const NON_TEACHING = /driver|ayah|aaya|aya\b|helper|clean|sweep|watch|security|guard|office|account|clerk|cashier|cook|maid|peon|attender|conductor|gardener|electric|plumb/i;
  staff.forEach(s => { const k = norm(s.name); if (k && !NON_TEACHING.test(String(s.role || ''))) { pool.add(k); display[k] = display[k] || s.name; } });

  const periodLabel = pi => {
    const p = tt.periods[Number(pi)] || {};
    return { label: p.label || ('Period ' + (Number(pi) + 1)), time: p.start ? (p.start + (p.end ? '–' + p.end : '')) : '' };
  };
  const extra = {};   // periods already given to someone as a substitute today
  absent.forEach(a => {
    a.periods = slots[a.key].sort((x, y) => Number(x.pi) - Number(y.pi)).map(s => {
      const free = Array.from(pool).filter(k => k !== a.key && isHere(k) && !(busy[k] && busy[k].has(s.pi)) && !(extra[k] && extra[k].has(s.pi)))
        .sort((x, y) => ((load[x] || 0) + (extra[x] ? extra[x].size : 0)) - ((load[y] || 0) + (extra[y] ? extra[y].size : 0)) || display[x].localeCompare(display[y]));
      const pick = free.slice(0, MAX_SUGGEST);
      if (pick[0]) (extra[pick[0]] = extra[pick[0]] || new Set()).add(s.pi);   // first suggestion is counted as given
      const pl = periodLabel(s.pi);
      return { period: pl.label, time: pl.time, class: s.cls, subject: s.subject, free: pick.map(k => display[k]) };
    });
    delete a.key;
  });
  return { absent, att_used: attUsed };
}

async function runSchool(schoolId, day, send) {
  const r = await plan(schoolId, day);
  if (!r.absent || !r.absent.length) return { skipped: r.reason || 'all teachers present', att_used: r.att_used };
  const periods = r.absent.reduce((n, a) => n + a.periods.length, 0);
  const uncovered = r.absent.reduce((n, a) => n + a.periods.filter(p => !p.free.length).length, 0);
  const title = '🔁 ' + r.absent.length + ' teacher' + (r.absent.length === 1 ? '' : 's') + ' absent — substitutes suggested';
  const body = r.absent.map(a => a.name).join(', ') + ' · ' + periods + ' period' + (periods === 1 ? '' : 's') + ' to cover' +
    (uncovered ? ' · ' + uncovered + ' with nobody free' : '');
  const data = { date: day, absent: r.absent, periods, uncovered };
  if (!send) return { title, body, data };

  const ins = await sb('POST', 'owner_alerts?on_conflict=school_id,kind,alert_date', [{
    school_id: schoolId, kind: 'substitutes', alert_date: day, title, body, data
  }], 'return=representation,resolution=ignore-duplicates').catch(() => []);
  if (!Array.isArray(ins) || !ins.length) return { already_sent: true };
  let phones = 0;
  if (pushReady()) {
    const subs = await safe(sb('GET', 'owner_push_subscriptions?school_id=eq.' + enc(schoolId) + '&select=id,endpoint,p256dh,auth'), []) || [];
    if (subs.length) {
      const out = await sendToSubs(subs, () => ({ title, body, tag: 'owner-subs-' + day,
        url: BASE + '/owner/index.html?alert=substitutes&date=' + day }), true);
      phones = out.sent;
    }
  }
  return { title, body, owner_phones: phones };
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

module.exports = async (req, res) => {
  if (!getServiceKey()) return res.status(500).json({ ok: false, error: 'Server key not configured.' });

  if (req.method === 'POST') {
    let body;
    try { body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); }
    catch (e) { return res.status(400).json({ ok: false, error: 'Invalid request.' }); }
    const s = verifyToken(body.token);
    if (!s || !s.sid || s.role === 'parent') return res.status(401).json({ ok: false, error: 'Please log in again.' });
    try {
      const r = await plan(String(s.sid), istTodayIso());
      return res.status(200).json(Object.assign({ ok: true, date: istTodayIso() }, r));
    } catch (e) { return res.status(500).json({ ok: false, error: String(e.message || e) }); }
  }

  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'GET or POST' });
  const secret = process.env.CRON_SECRET || '';
  const q = req.query || {};
  const auth = String(req.headers.authorization || '');
  if (!secret || (auth !== 'Bearer ' + secret && String(q.key || '') !== secret)) {
    return res.status(401).json({ ok: false, error: 'Not allowed.' });
  }
  const dry = q.dry === '1';
  const day = dry && /^\d{4}-\d{2}-\d{2}$/.test(String(q.date || '')) ? String(q.date) : istTodayIso();
  const out = { ok: true, date: day, dry, schools: {} };
  try {
    const ids = q.school ? [String(q.school)]
      : Array.from(new Set((await sb('GET', 'owner_app_users?select=school_id&limit=5000') || []).map(r => String(r.school_id))));
    for (const id of ids) {
      try { out.schools[id] = await runSchool(id, day, !dry); }
      catch (e) { out.schools[id] = { ok: false, error: String(e.message || e) }; }
    }
    return res.status(200).json(out);
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};

module.exports.plan = plan;
