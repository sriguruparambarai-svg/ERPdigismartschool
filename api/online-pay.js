// DigiSmart ERP — Online Fee Payment (Cashfree)
// Each school connects its OWN Cashfree account; money settles straight to the
// school's bank. DigiSmart never holds funds.
//
// Staff (owner / Fee Management full access):
//   POST { token, action: 'get_settings' }
//   POST { token, action: 'save_settings', mode, client_id, client_secret?, conv_fee_percent, enabled }
// Parent:
//   POST { token, action: 'status' }                → is online payment on? fee %
//   POST { token, action: 'dues' }                  → payable items (server-computed)
//   POST { token, action: 'create_order', keys[] }  → Cashfree session for chosen items
//   POST { token, action: 'verify', order_id }      → confirm with Cashfree, record receipt
// Cashfree:
//   POST ?cf=notify   (notify_url)                  → re-checked with Cashfree before recording
//
// Security: amounts are always recomputed on the server; a payment is recorded
// only after Cashfree's own API says the order is PAID for the exact amount.
// The school's secret key is stored encrypted and never sent back to a browser.

const crypto = require('crypto');
const { computeDues } = require('./_fees');

const SUPABASE_URL = 'https://nkfxrbumhjztmdyepygt.supabase.co';
const CF_API_VERSION = '2025-01-01';
const CF_BASE = { sandbox: 'https://sandbox.cashfree.com/pg', production: 'https://api.cashfree.com/pg' };

function getServiceKey() {
  return process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
}
const enc = encodeURIComponent;

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

async function sb(method, path, bodyObj, prefer) {
  const key = getServiceKey();
  const opts = {
    method,
    headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', Prefer: prefer || 'return=representation' }
  };
  if (bodyObj) opts.body = JSON.stringify(bodyObj);
  const r = await fetch(SUPABASE_URL + '/rest/v1/' + path, opts);
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
  if (!r.ok) throw new Error((data && data.message) || ('Database error ' + r.status));
  return data;
}

// ── Secret key encryption (AES-256-GCM) ──
function encKey() {
  const base = process.env.PAYMENT_ENC_KEY || getServiceKey();
  return crypto.createHash('sha256').update('digismart-payments:' + base).digest();
}
function encryptSecret(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', encKey(), iv);
  const out = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return [iv.toString('base64'), c.getAuthTag().toString('base64'), out.toString('base64')].join('.');
}
function decryptSecret(blob) {
  const [iv, tag, data] = String(blob || '').split('.');
  const d = crypto.createDecipheriv('aes-256-gcm', encKey(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
}

async function getSettings(schoolId) {
  return (await sb('GET', 'payment_gateway_settings?school_id=eq.' + enc(schoolId) + '&select=*&limit=1') || [])[0] || null;
}

async function cashfree(settings, method, path, bodyObj) {
  const mode = settings.mode === 'production' ? 'production' : 'sandbox';
  const r = await fetch(CF_BASE[mode] + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'x-api-version': CF_API_VERSION,
      'x-client-id': settings.client_id,
      'x-client-secret': decryptSecret(settings.client_secret_enc)
    },
    body: bodyObj ? JSON.stringify(bodyObj) : undefined
  });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
  return { status: r.status, ok: r.ok, data };
}

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
function convFee(amount, pct) { return round2(amount * (Math.max(0, Math.min(Number(pct) || 0, 5)) / 100)); }

// ── Confirm an order with Cashfree and record it (safe to call many times) ──
async function settleOrder(orderId) {
  const op = (await sb('GET', 'online_payments?order_id=eq.' + enc(orderId) + '&select=*&limit=1') || [])[0];
  if (!op) return { ok: false, error: 'Order not found.' };
  if (op.status === 'paid') return { ok: true, status: 'paid', receipt_no: op.receipt_no, total: op.total_amount };
  if (op.status === 'processing') return { ok: true, status: 'processing' };

  const settings = await getSettings(op.school_id);
  if (!settings) return { ok: false, error: 'Payment settings missing.' };

  const res = await cashfree(settings, 'GET', '/orders/' + enc(orderId));
  if (!res.ok || !res.data) return { ok: false, error: 'Could not reach Cashfree. Please try again.' };
  const order = res.data;

  if (order.order_status !== 'PAID') {
    const failed = order.order_status === 'EXPIRED' || order.order_status === 'TERMINATED';
    if (failed && op.status === 'created') {
      await sb('PATCH', 'online_payments?order_id=eq.' + enc(orderId) + '&status=eq.created', { status: 'failed', updated_at: new Date().toISOString() }, 'return=minimal');
    }
    return { ok: true, status: failed ? 'failed' : 'pending' };
  }
  if (round2(order.order_amount) !== round2(op.total_amount)) {
    await sb('PATCH', 'online_payments?order_id=eq.' + enc(orderId), { status: 'amount_mismatch', updated_at: new Date().toISOString() }, 'return=minimal');
    return { ok: false, error: 'Amount mismatch — the school office will check this payment.' };
  }

  // Claim the order so only one process records it (webhook and parent may arrive together)
  const claimed = await sb('PATCH', 'online_payments?order_id=eq.' + enc(orderId) + '&status=in.(created,failed)',
    { status: 'processing', updated_at: new Date().toISOString() });
  if (!Array.isArray(claimed) || !claimed.length) return { ok: true, status: 'processing' };

  // Payment details (UPI / card, bank reference)
  let payment = {};
  try {
    const pr = await cashfree(settings, 'GET', '/orders/' + enc(orderId) + '/payments');
    if (pr.ok && Array.isArray(pr.data)) payment = pr.data.find(p => p.payment_status === 'SUCCESS') || {};
  } catch (e) { payment = {}; }

  const year = new Date(Date.now() + 5.5 * 3600 * 1000).getUTCFullYear();
  const receiptNo = 'ONL-' + year + '-' + String(op.id).padStart(5, '0');
  const ist = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
  const group = String(payment.payment_group || '').toLowerCase();
  const modeText = group.indexOf('upi') !== -1 ? 'Online UPI'
    : group.indexOf('card') !== -1 ? 'Online Card'
    : group === 'net_banking' ? 'Online Netbanking'
    : group === 'wallet' ? 'Online Wallet' : 'Online';
  const reference = payment.bank_reference || payment.cf_payment_id || order.cf_order_id || '';
  const items = Array.isArray(op.items) ? op.items : [];
  const stu = (await sb('GET', 'students?id=eq.' + enc(op.student_id) + '&select=full_name,class,admission_no&limit=1') || [])[0] || {};

  try {
    await sb('POST', 'fee_payments', items.map(it => ({
      school_id: op.school_id,
      student_id: op.student_id,
      student_name: stu.full_name || '',
      student_class: stu.class || '',
      admission_no: stu.admission_no || '',
      fee_head_id: it.fee_head_id,
      fee_head_name: it.fee_head_name,
      period: it.period,
      amount_paid: it.amount,
      is_late_fee: !!it.is_late_fee,
      payment_mode: modeText,
      payment_date: ist,
      reference_no: String(reference).slice(0, 60),
      remarks: 'Paid online by parent (Cashfree ' + orderId + ')',
      receipt_no: receiptNo
    })), 'return=minimal');
  } catch (e) {
    await sb('PATCH', 'online_payments?order_id=eq.' + enc(orderId), { status: 'paid_not_recorded', updated_at: new Date().toISOString() }, 'return=minimal');
    return { ok: false, error: 'Payment received but the receipt could not be saved. The school office will fix this — no need to pay again.' };
  }

  await sb('PATCH', 'online_payments?order_id=eq.' + enc(orderId), {
    status: 'paid', receipt_no: receiptNo, payment_mode: modeText,
    cf_payment_id: payment.cf_payment_id ? String(payment.cf_payment_id) : null,
    bank_reference: payment.bank_reference || null,
    paid_at: new Date().toISOString(), updated_at: new Date().toISOString()
  }, 'return=minimal');

  return { ok: true, status: 'paid', receipt_no: receiptNo, total: op.total_amount };
}

module.exports = async (req, res) => {
  if (!getServiceKey()) return res.status(500).json({ ok: false, error: 'Server key not configured.' });
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });

  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); }
  catch (e) { return res.status(400).json({ ok: false, error: 'Invalid request.' }); }

  // ══ Cashfree server notification — never trusted, always re-checked ══
  if ((req.query || {}).cf === 'notify') {
    try {
      const orderId = body && body.data && body.data.order && body.data.order.order_id;
      if (orderId && /^[A-Za-z0-9_-]{3,45}$/.test(orderId)) await settleOrder(orderId);
    } catch (e) { /* Cashfree retries on non-200; the parent's verify also settles */ }
    return res.status(200).json({ ok: true });
  }

  const session = verifyToken(body.token);
  if (!session || !session.sid) return res.status(401).json({ ok: false, error: 'Session expired. Please log in again.' });
  const schoolId = String(session.sid);
  const action = body.action;

  try {
    // ══ STAFF: settings ══
    if (action === 'get_settings' || action === 'save_settings') {
      const mods = Array.isArray(session.mods) ? session.mods : [];
      const allowed = session.role === 'owner' || mods.indexOf('fee') !== -1;
      if (session.role === 'parent' || !allowed) return res.status(403).json({ ok: false, error: 'Only the owner or Fee Management (full) staff can change online payment settings.' });

      const current = await getSettings(schoolId);
      if (action === 'get_settings') {
        return res.status(200).json({
          ok: true,
          settings: current ? {
            mode: current.mode, client_id: current.client_id, has_secret: !!current.client_secret_enc,
            conv_fee_percent: current.conv_fee_percent, enabled: !!current.enabled, updated_at: current.updated_at
          } : null,
          notify_url: 'https://' + (req.headers.host || 'erp.digismartschool.com') + '/api/online-pay?cf=notify'
        });
      }

      const mode = body.mode === 'production' ? 'production' : 'sandbox';
      const clientId = String(body.client_id || '').trim();
      const newSecret = String(body.client_secret || '').trim();
      const pct = Number(body.conv_fee_percent);
      if (!/^[A-Za-z0-9_.-]{6,100}$/.test(clientId)) return res.status(400).json({ ok: false, error: 'Please paste a valid App ID (Client ID).' });
      if (!(pct >= 0 && pct <= 5)) return res.status(400).json({ ok: false, error: 'Convenience fee must be between 0% and 5%.' });
      if (!newSecret && !(current && current.client_secret_enc)) return res.status(400).json({ ok: false, error: 'Please paste the Secret Key.' });
      if (newSecret && newSecret.length > 200) return res.status(400).json({ ok: false, error: 'Secret Key looks wrong.' });

      const record = {
        school_id: schoolId, provider: 'cashfree', mode, client_id: clientId,
        client_secret_enc: newSecret ? encryptSecret(newSecret) : current.client_secret_enc,
        conv_fee_percent: round2(pct), enabled: !!body.enabled, updated_at: new Date().toISOString()
      };

      // Check the keys work: a lookup of a made-up order returns 404 for good keys, 401 for bad
      const test = await cashfree(record, 'GET', '/orders/digismart_key_check_' + Date.now());
      if (test.status === 401 || test.status === 403) {
        return res.status(400).json({ ok: false, error: 'Cashfree rejected these keys. Check the App ID, Secret Key and that ' + (mode === 'production' ? 'Live' : 'Test') + ' mode matches the keys.' });
      }
      if (test.status >= 500 || test.status === 0) {
        return res.status(502).json({ ok: false, error: 'Could not reach Cashfree to check the keys. Please try again.' });
      }

      await sb('POST', 'payment_gateway_settings?on_conflict=school_id', [record], 'return=minimal,resolution=merge-duplicates');
      return res.status(200).json({ ok: true });
    }

    // ══ PARENT actions ══
    if (session.role !== 'parent' || !session.stu) return res.status(403).json({ ok: false, error: 'Parents only.' });
    const studentId = String(session.stu);
    const settings = await getSettings(schoolId);
    const live = !!(settings && settings.enabled && settings.client_id && settings.client_secret_enc);

    if (action === 'status') {
      return res.status(200).json({ ok: true, enabled: live, conv_fee_percent: live ? Number(settings.conv_fee_percent) || 0 : 0, test_mode: live && settings.mode !== 'production' });
    }

    if (action === 'verify') {
      const orderId = String(body.order_id || '');
      const op = (await sb('GET', 'online_payments?order_id=eq.' + enc(orderId) + '&student_id=eq.' + enc(studentId) + '&select=id&limit=1') || [])[0];
      if (!op) return res.status(404).json({ ok: false, error: 'Payment not found.' });
      return res.status(200).json(await settleOrder(orderId));
    }

    if (!live) return res.status(200).json({ ok: false, error: 'Online payment is not switched on by the school.' });

    if (action === 'dues') {
      const { items } = await computeDues(sb, schoolId, studentId);
      return res.status(200).json({ ok: true, items: items.map(i => ({ key: i.key, group: i.group, label: i.label, period: i.period, amount: i.amount })), conv_fee_percent: Number(settings.conv_fee_percent) || 0 });
    }

    if (action === 'create_order') {
      const keys = Array.isArray(body.keys) ? body.keys.map(String).slice(0, 60) : [];
      if (!keys.length) return res.status(400).json({ ok: false, error: 'Please choose at least one fee item.' });
      const { student, items } = await computeDues(sb, schoolId, studentId);
      const chosen = items.filter(i => keys.indexOf(i.key) !== -1);
      if (chosen.length !== keys.length) return res.status(409).json({ ok: false, error: 'Some fees have changed or were already paid. Please refresh and try again.' });
      // A late fee is added for any overdue term the parent is paying
      chosen.slice().forEach(c => {
        if (c.group !== 'fee') return;
        const lf = items.find(i => i.key === 'late|' + c.period);
        if (lf && chosen.indexOf(lf) === -1) chosen.push(lf);
      });

      const feeAmount = round2(chosen.reduce((t, i) => t + i.amount, 0));
      if (feeAmount < 1) return res.status(400).json({ ok: false, error: 'Amount too small for online payment.' });
      const fee = convFee(feeAmount, settings.conv_fee_percent);
      const total = round2(feeAmount + fee);
      const orderId = 'DS' + Date.now().toString(36).toUpperCase() + crypto.randomBytes(4).toString('hex').toUpperCase();

      const row = (await sb('POST', 'online_payments', [{
        school_id: schoolId, student_id: studentId, order_id: orderId, mode: settings.mode,
        items: chosen.map(i => ({ fee_head_id: i.fee_head_id, fee_head_name: i.fee_head_name, period: i.period, amount: i.amount, is_late_fee: !!i.is_late_fee, label: i.label })),
        fee_amount: feeAmount, conv_fee: fee, total_amount: total, status: 'created'
      }]) || [])[0];
      if (!row) return res.status(500).json({ ok: false, error: 'Could not start the payment.' });

      const host = 'https://' + (req.headers.host || 'erp.digismartschool.com');
      const phone = String(student.mobile || '').replace(/\D/g, '').slice(-10);
      const cf = await cashfree(settings, 'POST', '/orders', {
        order_id: orderId,
        order_amount: total,
        order_currency: 'INR',
        customer_details: {
          customer_id: ('S' + String(studentId).replace(/[^A-Za-z0-9]/g, '')).slice(0, 50),
          customer_name: (String(student.full_name || 'Parent').trim() + '   ').slice(0, 100).trim().padEnd(3, '.'),
          customer_phone: phone.length === 10 ? phone : '9999999999'
        },
        order_meta: {
          return_url: host + '/parent/dashboard.html?pay_order=' + orderId,
          notify_url: host + '/api/online-pay?cf=notify'
        },
        order_expiry_time: new Date(Date.now() + 2 * 3600 * 1000).toISOString(),
        order_note: ('School fees ' + (student.admission_no || '')).slice(0, 200),
        order_tags: { school: String(schoolId).slice(0, 255), admission_no: String(student.admission_no || '-').slice(0, 255) }
      });
      if (!cf.ok || !cf.data || !cf.data.payment_session_id) {
        await sb('PATCH', 'online_payments?order_id=eq.' + enc(orderId), { status: 'failed', updated_at: new Date().toISOString() }, 'return=minimal');
        return res.status(502).json({ ok: false, error: 'Cashfree could not start the payment' + (cf.data && cf.data.message ? ': ' + cf.data.message : '.') });
      }
      return res.status(200).json({
        ok: true, order_id: orderId, payment_session_id: cf.data.payment_session_id,
        mode: settings.mode === 'production' ? 'production' : 'sandbox',
        fee_amount: feeAmount, conv_fee: fee, total
      });
    }

    return res.status(400).json({ ok: false, error: 'Unknown action.' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};

