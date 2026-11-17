// DigiSmart ERP — Live Bus Tracking (fitted GPS devices via Traccar)
//
// Device → Traccar server → this API. Traccar is set with:
//   forward.url   = https://erp.digismartschool.com/api/bus-gps?src=traccar
//   forward.type  = json
//   forward.header = Authorization: Bearer <TRACCAR_FORWARD_SECRET>
//   event.forward.url / event.forward.header = same (for SOS panic button)
//
// POST ?src=traccar                         → store position, trip + near-stop alerts, SOS
// POST { token(parent), action:'track' }    → this child's bus only, during trip times
// POST { token(staff),  action:'live' }     → all buses of the school
// POST { token(staff),  action:'save_stops', route_id, stops:[{name,lat,lng}] }
// POST { token(staff),  action:'ack_alert', alert_id }
//
// Vercel settings: TRACCAR_FORWARD_SECRET (+ existing SUPABASE_SERVICE_KEY, VAPID keys)

const crypto = require('crypto');
const { sb, enc, getServiceKey, sendToSubs, logOnce, subsForStudents, pushReady } = require('./_push');

const LIVE_SECONDS = 180;          // a position older than this = bus offline
const NEAR_STOP_KM = 1.5;          // "bus is near your stop" distance
const AVG_KMH = 25;                // for minutes-away estimates

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

function km(lat1, lon1, lat2, lon2) {
  const R = 6371, t = x => x * Math.PI / 180;
  const a = Math.sin(t(lat2 - lat1) / 2) ** 2 + Math.cos(t(lat1)) * Math.cos(t(lat2)) * Math.sin(t(lon2 - lon1) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
function istNow() {
  const d = new Date(Date.now() + 5.5 * 3600 * 1000);
  return { date: d.toISOString().slice(0, 10), mins: d.getUTCHours() * 60 + d.getUTCMinutes(), day: d.getUTCDay() };
}
// Trip windows (IST): morning 05:00–10:30, evening 12:00–19:30, Monday–Saturday
function tripSession(now) {
  if (now.day === 0) return null;
  if (now.mins >= 300 && now.mins <= 630) return 'am';
  if (now.mins >= 720 && now.mins <= 1170) return 'pm';
  return null;
}
function hhmmToMins(t) {
  const m = String(t || '').match(/^(\d{1,2}):(\d{2})/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}
function parentUrl(host, schoolId) {
  return 'https://' + host + '/parent/index.html?school=' + enc(schoolId);
}

// Students riding this bus, with their stop and timings
async function ridersOfBus(schoolId, busId) {
  const routes = await sb('GET', 'bus_routes?school_id=eq.' + enc(schoolId) + '&bus_id=eq.' + enc(busId) + '&select=id,name') || [];
  if (!routes.length) return { routes: [], riders: [] };
  const riders = await sb('GET', 'student_transport?school_id=eq.' + enc(schoolId) + '&route_id=in.(' + routes.map(r => enc(r.id)).join(',') +
    ')&select=student_id,student_name,route_id,boarding_stop,morning_time,evening_time') || [];
  return { routes, riders };
}

async function handleTraccar(req, res, body) {
  const secret = process.env.TRACCAR_FORWARD_SECRET || '';
  if (!secret || (req.headers.authorization || '') !== 'Bearer ' + secret) {
    return res.status(401).json({ ok: false, error: 'Not allowed' });
  }
  const device = body.device || {};
  const pos = body.position || {};
  const event = body.event || null;
  const imei = String(device.uniqueId || '').trim();
  if (!imei) return res.status(200).json({ ok: true, skipped: 'no device id' });

  const bus = (await sb('GET', 'buses?gps_imei=eq.' + enc(imei) + '&select=id,school_id,bus_number&limit=1') || [])[0];
  if (!bus) return res.status(200).json({ ok: true, skipped: 'device not linked to a bus' });

  const attrs = pos.attributes || {};
  const lat = Number(pos.latitude), lng = Number(pos.longitude);
  const hasFix = isFinite(lat) && isFinite(lng) && !(lat === 0 && lng === 0) && pos.valid !== false;
  const speedKmh = Math.round((Number(pos.speed) || 0) * 1.852);   // Traccar speed is in knots
  const host = req.headers.host || 'erp.digismartschool.com';

  // ── SOS / panic button ──
  const isSos = String(attrs.alarm || '').toLowerCase() === 'sos' ||
    (event && event.type === 'alarm' && String((event.attributes || {}).alarm || '').toLowerCase() === 'sos');
  if (isSos) {
    const minute = Math.floor(Date.now() / 300000);    // one alert per bus per 5 minutes
    if (await logOnce(bus.school_id, 'sos', bus.id + ':' + minute)) {
      await sb('POST', 'bus_alerts', [{ school_id: bus.school_id, bus_id: bus.id, kind: 'sos', latitude: hasFix ? lat : null, longitude: hasFix ? lng : null }], 'return=minimal');
    }
  }
  if (!hasFix) return res.status(200).json({ ok: true, sos: isSos });

  const fixTime = pos.fixTime || pos.deviceTime || new Date().toISOString();
  await sb('POST', 'bus_live?on_conflict=bus_id', [{
    bus_id: bus.id, school_id: bus.school_id, imei, latitude: lat, longitude: lng, speed_kmh: speedKmh,
    course: Number(pos.course) || 0, ignition: attrs.ignition === undefined ? null : !!attrs.ignition,
    fix_time: fixTime, updated_at: new Date().toISOString()
  }], 'return=minimal,resolution=merge-duplicates');

  // ── Parent alerts (only during trip windows, only if alerts are set up) ──
  const now = istNow();
  const session = tripSession(now);
  if (!session || !pushReady()) return res.status(200).json({ ok: true });

  const { riders } = await ridersOfBus(bus.school_id, bus.id);
  if (!riders.length) return res.status(200).json({ ok: true });
  const url = parentUrl(host, bus.school_id);
  let sent = 0;

  // 1. Bus has started — first real movement in this trip window
  if (speedKmh >= 8 && await logOnce(bus.school_id, 'bus_start', bus.id + ':' + now.date + ':' + session)) {
    const subs = await subsForStudents(riders.map(r => r.student_id));
    const out = await sendToSubs(subs, () => ({
      title: '🚌 Bus has started',
      body: 'Bus ' + bus.bus_number + ' has started its ' + (session === 'am' ? 'morning pickup' : 'evening drop') + ' trip. Tap to track.',
      tag: 'bus-start-' + bus.id + '-' + session, url
    }), false);
    sent += out.sent;
  }

  // 2. Near your stop — once per child per trip
  const stopRows = await sb('GET', 'bus_stop_locations?school_id=eq.' + enc(bus.school_id) + '&route_id=in.(' +
    [...new Set(riders.map(r => r.route_id))].map(enc).join(',') + ')&select=route_id,stop_name,latitude,longitude') || [];
  for (const r of riders) {
    const stop = stopRows.find(s => s.route_id === r.route_id && s.stop_name === r.boarding_stop);
    if (!stop) continue;
    const dist = km(lat, lng, Number(stop.latitude), Number(stop.longitude));
    if (dist > NEAR_STOP_KM) continue;
    // Respect the child's own pickup/drop time when set (avoids alerts on the wrong leg)
    const t = hhmmToMins(session === 'am' ? r.morning_time : r.evening_time);
    if (t !== null && (now.mins < t - 45 || now.mins > t + 20)) continue;
    if (!(await logOnce(bus.school_id, 'bus_near', r.student_id + ':' + now.date + ':' + session))) continue;
    const mins = Math.max(1, Math.round(dist / AVG_KMH * 60));
    const subs = await subsForStudents([r.student_id]);
    const out = await sendToSubs(subs, () => ({
      title: '📍 Bus is near your stop',
      body: 'Bus ' + bus.bus_number + ' is about ' + mins + ' min from ' + (r.boarding_stop || 'your stop') + (session === 'am' ? '. Please be ready.' : '.'),
      tag: 'bus-near-' + r.student_id + '-' + session, url
    }), true);
    sent += out.sent;
  }
  return res.status(200).json({ ok: true, alerts_sent: sent });
}

// ══ Van delay / van update messages to the Parents App (Nov 2026) ══
// The office picks a route (and, if needed, only some stops). The message is built
// here on the server — never taken from the browser — so it always carries the
// school's own name, and the Tamil line when the school's "Tamil messages" switch is on.
const VAN_REASONS = {
  traffic:   ['heavy traffic', 'போக்குவரத்து நெரிசல்'],
  breakdown: ['a vehicle breakdown', 'வண்டி பழுது'],
  rain:      ['heavy rain', 'கனமழை'],
  accident:  ['a road accident on the way', 'வழியில் ஏற்பட்ட விபத்து'],
  tyre:      ['a flat tyre', 'டயர் பஞ்சர்'],
  other:     ['an unexpected situation', 'எதிர்பாராத காரணம்']
};
function vanDelayText(kind, routeName, mins, reasonKey, schoolName, morning, tamil) {
  const r = VAN_REASONS[reasonKey] || VAN_REASONS.other;
  let en, ta;
  if (kind === 'reached') {
    en = morning
      ? 'Update: The ' + routeName + ' van has reached school safely. Thank you for your patience.'
      : 'Update: The ' + routeName + ' van is on its way now and will reach your stop shortly. Thank you for your patience.';
    ta = morning
      ? routeName + ' வேன் பள்ளிக்கு பாதுகாப்பாக வந்து சேர்ந்தது. பொறுமைக்கு நன்றி.'
      : routeName + ' வேன் இப்போது புறப்பட்டு விட்டது, விரைவில் உங்கள் நிறுத்தத்திற்கு வரும். பொறுமைக்கு நன்றி.';
  } else {
    en = 'The ' + routeName + ' van is running about ' + mins + ' minutes late today due to ' + r[0] + '. Please don\'t worry. Sorry for the inconvenience.';
    ta = 'இன்று ' + routeName + ' வேன் ' + r[1] + ' காரணமாக சுமார் ' + mins + ' நிமிடம் தாமதமாக வரும். கவலைப்பட வேண்டாம். சிரமத்திற்கு வருந்துகிறோம்.';
  }
  const sign = '— ' + (schoolName || 'School');
  return tamil ? en + '\n' + ta + '\n' + sign : en + '\n' + sign;
}
function istDayStartUtc() {
  // midnight India time today, as a UTC timestamp
  const d = new Date(Date.now() + 5.5 * 3600 * 1000);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - 5.5 * 3600 * 1000).toISOString();
}

module.exports = async (req, res) => {
  if (!getServiceKey()) return res.status(500).json({ ok: false, error: 'Server key not configured.' });
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); }
  catch (e) { return res.status(400).json({ ok: false, error: 'Invalid request.' }); }

  try {
    if ((req.query || {}).src === 'traccar') return await handleTraccar(req, res, body);

    const session = verifyToken(body.token);
    if (!session || !session.sid) return res.status(401).json({ ok: false, error: 'Session expired. Please log in again.' });
    const schoolId = String(session.sid);
    const action = body.action;

    // ══ PARENT: my child's bus ══
    if (action === 'track') {
      if (session.role !== 'parent' || !session.stu) return res.status(403).json({ ok: false, error: 'Parents only.' });
      const st = (await sb('GET', 'student_transport?student_id=eq.' + enc(session.stu) + '&school_id=eq.' + enc(schoolId) +
        '&select=route_id,route_name,boarding_stop,morning_time,evening_time&limit=1') || [])[0];
      if (!st) return res.status(200).json({ ok: true, has_transport: false });
      const route = st.route_id ? (await sb('GET', 'bus_routes?id=eq.' + enc(st.route_id) + '&school_id=eq.' + enc(schoolId) + '&select=id,name,bus_id&limit=1') || [])[0] : null;
      const busRow = route && route.bus_id ? (await sb('GET', 'buses?id=eq.' + enc(route.bus_id) + '&select=id,bus_number,driver_name,driver_mobile,gps_imei&limit=1') || [])[0] : null;
      const stop = route ? (await sb('GET', 'bus_stop_locations?route_id=eq.' + enc(route.id) + '&stop_name=eq.' + enc(st.boarding_stop || '') + '&select=latitude,longitude&limit=1') || [])[0] : null;
      const base = {
        ok: true, has_transport: true, route_name: (route && route.name) || st.route_name || '', stop_name: st.boarding_stop || '',
        morning_time: st.morning_time, evening_time: st.evening_time,
        bus_number: busRow ? busRow.bus_number : '', driver_name: busRow ? busRow.driver_name : '', driver_mobile: busRow ? busRow.driver_mobile : '',
        has_device: !!(busRow && busRow.gps_imei),
        stop: stop ? { lat: Number(stop.latitude), lng: Number(stop.longitude) } : null
      };
      const now = istNow();
      if (!tripSession(now)) return res.status(200).json(Object.assign(base, { window: false }));
      const live = busRow ? (await sb('GET', 'bus_live?bus_id=eq.' + enc(busRow.id) + '&select=latitude,longitude,speed_kmh,course,updated_at&limit=1') || [])[0] : null;
      const age = live ? Math.round((Date.now() - new Date(live.updated_at).getTime()) / 1000) : null;
      const out = Object.assign(base, { window: true, live: null });
      if (live && age <= LIVE_SECONDS) {
        out.live = { lat: Number(live.latitude), lng: Number(live.longitude), speed_kmh: Number(live.speed_kmh) || 0, course: Number(live.course) || 0, age_seconds: age };
        if (stop) {
          const d = km(out.live.lat, out.live.lng, stop.latitude, stop.longitude);
          out.distance_km = Math.round(d * 10) / 10;
          out.eta_minutes = Math.max(1, Math.round(d / AVG_KMH * 60));
        }
      }
      return res.status(200).json(out);
    }

    // ══ PARENT: today's van messages for this child (Nov 2026) ══
    if (action === 'van_msgs') {
      if (session.role !== 'parent' || !session.stu) return res.status(403).json({ ok: false, error: 'Parents only.' });
      let rows = [];
      try {
        rows = await sb('GET', 'transport_messages?school_id=eq.' + enc(schoolId) +
          '&student_ids=cs.' + enc(JSON.stringify([String(session.stu)])) +
          '&created_at=gte.' + enc(istDayStartUtc()) +
          '&select=kind,route_name,message,created_at&order=created_at.desc&limit=3') || [];
      } catch (e) { rows = []; }   // table not created yet → no card
      return res.status(200).json({ ok: true, data: rows });
    }

    // ══ STAFF ══
    const mods = Array.isArray(session.mods) ? session.mods : [];
    if (session.role === 'parent' || !(session.role === 'owner' || mods.indexOf('transport') !== -1)) {
      return res.status(403).json({ ok: false, error: 'You do not have permission for Transport.' });
    }

    if (action === 'live') {
      const live = await sb('GET', 'bus_live?school_id=eq.' + enc(schoolId) + '&select=bus_id,latitude,longitude,speed_kmh,course,ignition,updated_at') || [];
      const stops = await sb('GET', 'bus_stop_locations?school_id=eq.' + enc(schoolId) + '&select=route_id,stop_name,latitude,longitude') || [];
      const alerts = await sb('GET', 'bus_alerts?school_id=eq.' + enc(schoolId) + '&acknowledged=is.false&select=id,bus_id,kind,latitude,longitude,created_at&order=created_at.desc&limit=10') || [];
      return res.status(200).json({ ok: true, live, stops, alerts, server_time: new Date().toISOString() });
    }

    if (action === 'save_stops') {
      const routeId = String(body.route_id || '');
      const route = (await sb('GET', 'bus_routes?id=eq.' + enc(routeId) + '&school_id=eq.' + enc(schoolId) + '&select=id,stops&limit=1') || [])[0];
      if (!route) return res.status(404).json({ ok: false, error: 'Route not found.' });
      const names = Array.isArray(route.stops) ? route.stops.map(String) : [];
      const rows = (Array.isArray(body.stops) ? body.stops : []).filter(s =>
        names.indexOf(String(s.name)) !== -1 && isFinite(Number(s.lat)) && isFinite(Number(s.lng)) &&
        Math.abs(Number(s.lat)) <= 90 && Math.abs(Number(s.lng)) <= 180
      ).map(s => ({ school_id: schoolId, route_id: routeId, stop_name: String(s.name), latitude: Number(s.lat), longitude: Number(s.lng), updated_at: new Date().toISOString() }));
      await sb('DELETE', 'bus_stop_locations?route_id=eq.' + enc(routeId) + '&school_id=eq.' + enc(schoolId), null, 'return=minimal');
      if (rows.length) await sb('POST', 'bus_stop_locations', rows, 'return=minimal');
      return res.status(200).json({ ok: true, saved: rows.length });
    }

    if (action === 'ack_alert') {
      await sb('PATCH', 'bus_alerts?id=eq.' + enc(body.alert_id) + '&school_id=eq.' + enc(schoolId), { acknowledged: true, acknowledged_at: new Date().toISOString() }, 'return=minimal');
      return res.status(200).json({ ok: true });
    }

    // Office: send a van delay / van update to the parents of one route (or some stops)
    if (action === 'send_van_msg') {
      const kind = body.kind === 'reached' ? 'reached' : 'delay';
      const routeId = String(body.route_id || '');
      if (!routeId) return res.status(400).json({ ok: false, error: 'Please select a route first.' });
      const route = (await sb('GET', 'bus_routes?id=eq.' + enc(routeId) + '&school_id=eq.' + enc(schoolId) + '&select=id,name&limit=1') || [])[0];
      if (!route) return res.status(404).json({ ok: false, error: 'Route not found.' });
      const stops = (Array.isArray(body.stops) ? body.stops : []).map(x => String(x).trim()).filter(Boolean).slice(0, 100);
      let riders = await sb('GET', 'student_transport?school_id=eq.' + enc(schoolId) + '&route_id=eq.' + enc(routeId) +
        '&select=student_id,boarding_stop') || [];
      if (stops.length) riders = riders.filter(r => stops.indexOf(String(r.boarding_stop || '').trim()) !== -1);
      const ids = [...new Set(riders.map(r => String(r.student_id || '')).filter(Boolean))];
      if (!ids.length) return res.status(400).json({ ok: false, error: stops.length ? 'No students are assigned to the ticked stops.' : 'No students are assigned to this route yet.' });

      // Same button pressed twice within a minute → send only once
      const minute = Math.floor(Date.now() / 60000);
      if (!(await logOnce(schoolId, 'van_msg', routeId + ':' + kind + ':' + stops.join('|') + ':' + minute))) {
        return res.status(200).json({ ok: true, already_sent: true });
      }

      let school = null;
      try { school = (await sb('GET', 'schools?school_id=eq.' + enc(schoolId) + '&select=name,has_tamil_msgs&limit=1') || [])[0]; }
      catch (e) { try { school = (await sb('GET', 'schools?school_id=eq.' + enc(schoolId) + '&select=name&limit=1') || [])[0]; } catch (e2) {} }
      const schoolName = (school && school.name) || '';
      const tamil = !!(school && school.has_tamil_msgs);
      const mins = [10, 15, 20, 30, 45, 60, 90].indexOf(Number(body.delay)) !== -1 ? Number(body.delay) : 15;
      const morning = istNow().mins < 720;
      const message = vanDelayText(kind, route.name, mins, String(body.reason || 'other'), schoolName, morning, tamil);

      let saved;
      try {
        saved = (await sb('POST', 'transport_messages', [{
          school_id: schoolId, route_id: routeId, route_name: route.name, kind, stops, student_ids: ids,
          message, sent_by: String(session.name || session.role || ''), students_count: ids.length
        }], 'return=representation') || [])[0];
      } catch (e) {
        return res.status(200).json({ ok: false, error: 'One-time setup needed: please run step-van-messages.sql in Supabase.' });
      }

      let sent = 0;
      if (pushReady()) {
        const subs = (await subsForStudents(ids)).filter(s => String(s.school_id) === schoolId);
        const firstLines = message.split('\n').slice(0, tamil ? 2 : 1).join('\n');
        const out = await sendToSubs(subs, () => ({
          title: kind === 'reached' ? '✅ Van update · ' + route.name : '🚌 Van running late · ' + route.name,
          body: firstLines.length > 320 ? firstLines.slice(0, 319) + '…' : firstLines,
          tag: 'van-' + (saved ? saved.id : routeId),
          url: parentUrl(req.headers.host || 'erp.digismartschool.com', schoolId)
        }), true);
        sent = out.sent;
      }
      if (saved) { try { await sb('PATCH', 'transport_messages?id=eq.' + enc(saved.id), { phones_reached: sent }, 'return=minimal'); } catch (e) {} }
      // Keep the Notification History on the Transport page in step
      try {
        await sb('POST', 'transport_notifications', [{ school_id: schoolId,
          message: '📲 Parents App · ' + route.name + (stops.length ? ' (' + stops.join(', ') + ')' : '') + ' · ' + ids.length + ' students · ' + sent + ' phone alerts — ' + message.split('\n')[0] }], 'return=minimal');
      } catch (e) {}
      return res.status(200).json({ ok: true, students: ids.length, phones: sent, message });
    }

    return res.status(400).json({ ok: false, error: 'Unknown action.' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};
