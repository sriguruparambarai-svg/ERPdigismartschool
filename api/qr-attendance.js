// DigiSmart ERP — QR Code Attendance API
// All checks happen on the SERVER (service key):
//   PIN verification, GPS distance check, auto in/out,
//   device lock, and all staff_attendance writes.
// The browser never writes attendance directly.
//
// POST { action: 'get_settings' | 'save_settings' | 'pins' |
//                'staff_names' | 'pair' | 'mark', ... }

const crypto = require('crypto');

const SUPABASE_URL = 'https://nkfxrbumhjztmdyepygt.supabase.co';
const GRACE_MINUTES = 10;          // same grace as face attendance
const DOUBLE_SCAN_MINUTES = 30;    // second scan within 30 min = ignored
const DEVICE_TOKEN_DAYS = 180;     // phone stays paired for ~6 months

function getServiceKey() {
  return process.env.SUPABASE_SERVICE_KEY
      || process.env.SUPABASE_SERVICE_ROLE_KEY
      || '';
}

// ── Token helpers (same HMAC style as staff-login.js) ──
function sign(payload) {
  const sig = crypto.createHmac('sha256', getServiceKey()).update(payload).digest('hex');
  return Buffer.from(payload).toString('base64') + '.' + sig;
}

function verify(token) {
  try {
    const [b64, sig] = String(token || '').split('.');
    if (!b64 || !sig) return null;
    const payload = Buffer.from(b64, 'base64').toString('utf8');
    const expect = crypto.createHmac('sha256', getServiceKey()).update(payload).digest('hex');
    if (sig !== expect) return null;
    const data = JSON.parse(payload);
    if (!data.exp || Date.now() > data.exp) return null;
    return data;
  } catch (e) { return null; }
}

// Device token carried by the staff member's phone after pairing
function makeDeviceToken(schoolId, staffId) {
  return sign(JSON.stringify({
    sid: schoolId,
    stf: staffId,
    typ: 'qrdev',
    exp: Date.now() + DEVICE_TOKEN_DAYS * 24 * 60 * 60 * 1000
  }));
}

// ── Supabase REST helpers (service key) ──
async function sbGet(path) {
  const key = getServiceKey();
  const r = await fetch(SUPABASE_URL + '/rest/v1/' + path, {
    headers: { apikey: key, Authorization: 'Bearer ' + key }
  });
  if (!r.ok) throw new Error('Database error (' + r.status + ')');
  return r.json();
}

async function sbWrite(path, method, bodyObj) {
  const key = getServiceKey();
  const r = await fetch(SUPABASE_URL + '/rest/v1/' + path, {
    method: method,
    headers: {
      apikey: key,
      Authorization: 'Bearer ' + key,
      'Content-Type': 'application/json',
      Prefer: 'return=representation'
    },
    body: JSON.stringify(bodyObj)
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error('Database write error (' + r.status + '): ' + t.slice(0, 200));
  }
  return r.json();
}

// ── Small utilities ──
function toMins(t) { const p = String(t).split(':').map(Number); return p[0] * 60 + p[1]; }

// Distance between two GPS points in metres (haversine)
function distanceMetres(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2)
          + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2))
          * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

// Current date/time in Indian time, independent of server timezone
function nowIST() {
  const ist = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  return {
    date: ist.toISOString().split('T')[0],
    time: ist.toISOString().slice(11, 16)   // HH:MM
  };
}

function fourDigitPin() {
  return String(crypto.randomInt(0, 10000)).padStart(4, '0');
}

// Owner/office session token from sessionStorage (digismart_session_token)
function verifyOwnerSession(token) {
  const data = verify(token);
  if (!data || !data.sid) return null;
  if (data.role === 'staff') return null;   // staff accounts cannot change QR settings
  return data;
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
    const action = String(body.action || '');

    // ────────────────────────────────────────
    // OWNER ACTIONS (need valid owner session)
    // ────────────────────────────────────────

    if (action === 'get_settings') {
      const sess = verifyOwnerSession(body.token);
      if (!sess) return res.status(401).json({ ok: false, error: 'Session expired. Please log in again.' });
      const rows = await sbGet('schools?school_id=eq.' + encodeURIComponent(sess.sid)
        + '&select=name,qr_lat,qr_lng,qr_radius,attendance_method&limit=1');
      if (!rows.length) return res.status(404).json({ ok: false, error: 'School not found.' });
      return res.status(200).json({ ok: true, settings: rows[0] });
    }

    if (action === 'save_settings') {
      const sess = verifyOwnerSession(body.token);
      if (!sess) return res.status(401).json({ ok: false, error: 'Session expired. Please log in again.' });
      const upd = {};
      if (body.lat !== undefined && body.lat !== null) upd.qr_lat = Number(body.lat);
      if (body.lng !== undefined && body.lng !== null) upd.qr_lng = Number(body.lng);
      if (body.radius) upd.qr_radius = Math.max(30, Math.min(1000, parseInt(body.radius, 10) || 100));
      if (body.method && ['face', 'qr', 'both'].includes(body.method)) upd.attendance_method = body.method;
      if (!Object.keys(upd).length) return res.status(400).json({ ok: false, error: 'Nothing to save.' });
      await sbWrite('schools?school_id=eq.' + encodeURIComponent(sess.sid), 'PATCH', upd);
      return res.status(200).json({ ok: true });
    }

    if (action === 'pins') {
      const sess = verifyOwnerSession(body.token);
      if (!sess) return res.status(401).json({ ok: false, error: 'Session expired. Please log in again.' });
      const staff = await sbGet('staff?school_id=eq.' + encodeURIComponent(sess.sid)
        + '&status=eq.active&select=id,name,role,employee_id,qr_pin&order=name');
      // Auto-generate a PIN for anyone missing one
      for (const s of staff) {
        if (!s.qr_pin) {
          s.qr_pin = fourDigitPin();
          await sbWrite('staff?id=eq.' + encodeURIComponent(s.id), 'PATCH', { qr_pin: s.qr_pin });
        }
      }
      return res.status(200).json({ ok: true, staff: staff });
    }

    // ────────────────────────────────────────
    // STAFF PHONE ACTIONS (scan.html)
    // ────────────────────────────────────────

    if (action === 'staff_names') {
      const school = String(body.school || '').trim();
      if (!school) return res.status(400).json({ ok: false, error: 'School missing in QR link.' });
      const rows = await sbGet('staff?school_id=eq.' + encodeURIComponent(school)
        + '&status=eq.active&select=id,name,role&order=name');
      const schools = await sbGet('schools?school_id=eq.' + encodeURIComponent(school) + '&select=name&limit=1');
      return res.status(200).json({
        ok: true,
        school_name: schools.length ? schools[0].name : '',
        staff: rows
      });
    }

    if (action === 'pair') {
      const school = String(body.school || '').trim();
      const staffId = String(body.staff_id || '').trim();
      const pin = String(body.pin || '').trim();
      if (!school || !staffId || !pin) {
        return res.status(400).json({ ok: false, error: 'Please select your name and enter your PIN.' });
      }
      const rows = await sbGet('staff?id=eq.' + encodeURIComponent(staffId)
        + '&school_id=eq.' + encodeURIComponent(school)
        + '&select=id,name,qr_pin,status&limit=1');
      if (!rows.length || rows[0].status !== 'active') {
        return res.status(404).json({ ok: false, error: 'Staff record not found.' });
      }
      if (!rows[0].qr_pin) {
        return res.status(403).json({ ok: false, error: 'No PIN set for you yet. Please ask the school office.' });
      }
      if (rows[0].qr_pin !== pin) {
        return res.status(401).json({ ok: false, error: 'Wrong PIN. Please try again.' });
      }
      return res.status(200).json({
        ok: true,
        device_token: makeDeviceToken(school, staffId),
        staff_name: rows[0].name
      });
    }

    if (action === 'mark') {
      const tok = verify(body.device_token);
      if (!tok || tok.typ !== 'qrdev') {
        return res.status(401).json({ ok: false, code: 'REPAIR', error: 'This phone needs to be set up again. Please enter your PIN.' });
      }
      const lat = Number(body.lat), lng = Number(body.lng);
      const deviceId = String(body.device_id || '').slice(0, 60);
      if (!isFinite(lat) || !isFinite(lng)) {
        return res.status(400).json({ ok: false, error: 'Location not received. Please allow location access and try again.' });
      }

      // 1. School settings
      const schools = await sbGet('schools?school_id=eq.' + encodeURIComponent(tok.sid)
        + '&select=qr_lat,qr_lng,qr_radius,attendance_method&limit=1');
      if (!schools.length) return res.status(404).json({ ok: false, error: 'School not found.' });
      const cfg = schools[0];
      if (cfg.attendance_method === 'face') {
        return res.status(403).json({ ok: false, error: 'QR attendance is switched off for this school.' });
      }
      if (cfg.qr_lat === null || cfg.qr_lng === null || cfg.qr_lat === undefined || cfg.qr_lng === undefined) {
        return res.status(403).json({ ok: false, error: 'School location not set yet. Please ask the school office.' });
      }

      // 2. GPS distance check
      const dist = distanceMetres(lat, lng, cfg.qr_lat, cfg.qr_lng);
      const radius = cfg.qr_radius || 100;
      if (dist > radius) {
        return res.status(403).json({ ok: false, error: 'You must be at school to mark attendance. (You are ' + dist + ' m away.)' });
      }

      // 3. Staff record
      const staffRows = await sbGet('staff?id=eq.' + encodeURIComponent(tok.stf)
        + '&school_id=eq.' + encodeURIComponent(tok.sid)
        + '&select=id,name,role,status,expected_check_in,expected_check_out&limit=1');
      if (!staffRows.length || staffRows[0].status !== 'active') {
        return res.status(403).json({ ok: false, error: 'Your staff record is not active. Please contact the office.' });
      }
      const st = staffRows[0];
      const expectedIn = st.expected_check_in ? String(st.expected_check_in).slice(0, 5) : '08:30';
      const expectedOut = st.expected_check_out ? String(st.expected_check_out).slice(0, 5) : '16:00';

      const now = nowIST();

      // 4. Device lock: one phone = one staff per day
      if (deviceId) {
        const others = await sbGet('staff_attendance?school_id=eq.' + encodeURIComponent(tok.sid)
          + '&date=eq.' + now.date
          + '&device_id=eq.' + encodeURIComponent(deviceId)
          + '&staff_id=neq.' + encodeURIComponent(st.id)
          + '&select=id&limit=1');
        if (others.length) {
          return res.status(403).json({ ok: false, error: 'This phone was already used for another staff member today.' });
        }
      }

      // 5. Auto in/out
      const existingRows = await sbGet('staff_attendance?staff_id=eq.' + encodeURIComponent(st.id)
        + '&date=eq.' + now.date + '&select=id,check_in,check_out&limit=1');
      const existing = existingRows.length ? existingRows[0] : null;

      if (!existing || !existing.check_in) {
        // CHECK IN (same late rule as face attendance)
        const isLate = toMins(now.time) > (toMins(expectedIn) + GRACE_MINUTES);
        const status = isLate ? 'late' : 'present';
        if (existing) {
          await sbWrite('staff_attendance?id=eq.' + encodeURIComponent(existing.id), 'PATCH',
            { check_in: now.time, status: status, method: 'qr', device_id: deviceId || null });
        } else {
          await sbWrite('staff_attendance', 'POST', [{
            school_id: tok.sid, staff_id: st.id, staff_name: st.name, staff_role: st.role,
            date: now.date, check_in: now.time, status: status, method: 'qr',
            device_id: deviceId || null
          }]);
        }
        return res.status(200).json({ ok: true, type: 'in', name: st.name, time: now.time, late: isLate });
      }

      if (existing.check_in && !existing.check_out) {
        // Ignore accidental double scans within 30 minutes
        const sinceIn = toMins(now.time) - toMins(String(existing.check_in).slice(0, 5));
        if (sinceIn >= 0 && sinceIn < DOUBLE_SCAN_MINUTES) {
          return res.status(200).json({ ok: true, type: 'info', name: st.name, message: 'Already checked in at ' + String(existing.check_in).slice(0, 5) + '. See you this evening!' });
        }
        // CHECK OUT (same working-hours + early-exit rules as face attendance)
        const isEarlyExit = toMins(now.time) < toMins(expectedOut);
        let workHours = '—';
        const inM = toMins(String(existing.check_in).slice(0, 5));
        const outM = toMins(now.time);
        const mins = outM - inM;
        if (mins > 0) workHours = Math.floor(mins / 60) + 'h ' + (mins % 60) + 'm';
        await sbWrite('staff_attendance?id=eq.' + encodeURIComponent(existing.id), 'PATCH',
          { check_out: now.time, working_hours: workHours, early_exit: isEarlyExit });
        return res.status(200).json({ ok: true, type: 'out', name: st.name, time: now.time, hours: workHours, early: isEarlyExit });
      }

      // Already fully done for the day
      return res.status(200).json({ ok: true, type: 'info', name: st.name, message: 'Attendance already completed for today. See you tomorrow!' });
    }

    return res.status(400).json({ ok: false, error: 'Unknown action.' });

  } catch (err) {
    console.error('qr-attendance error:', err);
    return res.status(500).json({ ok: false, error: 'Something went wrong. Please try again.' });
  }
};
