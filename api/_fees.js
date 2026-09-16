// DigiSmart ERP — shared fee-dues calculator (server side)
// Mirrors the Collect Fee box in pages/fee.html exactly, so a parent paying
// online can only ever be charged what the school counter would charge:
// class fee heads per term/month, custom student amounts, RTE and 5-Year
// Scheme waivers, van months or the one-time van plan, and late fees.
// Files starting with "_" are not turned into public API endpoints by Vercel.

const LATE_FEE_ID = '00000000-0000-4000-8000-0000000000fe';
const LATE_FEE_NAME = 'Late Fee';
const VAN_ONETIME_PERIOD = 'One-Time';
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

function parseJson(v, fallback) {
  if (v == null) return fallback;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch (e) { return fallback; }
}
function money(n) { return Math.round((parseFloat(n) || 0) * 100) / 100; }

// Today's date in India, as a Date at local midnight (server runs in UTC)
function istToday() {
  const ist = new Date(Date.now() + 5.5 * 3600 * 1000);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()));
}

async function computeDues(sb, schoolId, studentId) {
  const enc = encodeURIComponent;
  const stu = (await sb('GET', 'students?id=eq.' + enc(studentId) + '&school_id=eq.' + enc(schoolId) +
    '&select=id,full_name,admission_no,class,section,mobile,father_name,admission_date,is_rte&limit=1') || [])[0];
  if (!stu) throw new Error('Student not found');

  const settings = (await sb('GET', 'fee_settings?school_id=eq.' + enc(schoolId) + '&select=*&limit=1') || [])[0] || {};
  const collectionMode = settings.collection_mode || 'term';
  const termConfig = parseJson(settings.term_config, null) || [{ name: 'Term 1', due: '' }, { name: 'Term 2', due: '' }, { name: 'Term 3', due: '' }];
  const monthStart = settings.month_start != null ? Number(settings.month_start) : 5;
  const monthCount = settings.month_count || 11;
  const lateCfg = Object.assign({ enabled: false, mode: 'fixed', amount: 0, grace_days: 0, frequency: 'once', max_amount: 0, due_day: 10 },
    parseJson(settings.late_fee_config, {}) || {});
  let vanMonths = parseJson(settings.van_months, []);
  if (!Array.isArray(vanMonths)) vanMonths = [];

  function getPeriods() {
    if (collectionMode === 'term') return termConfig.map(t => t.name).filter(Boolean);
    if (collectionMode === 'month') {
      const list = [];
      for (let i = 0; i < monthCount; i++) list.push(MONTHS[(monthStart + i) % 12]);
      return list;
    }
    return String(settings.custom_periods || '').split(',').map(s => s.trim()).filter(Boolean);
  }
  const periods = getPeriods();

  const heads = await sb('GET', 'fee_heads?school_id=eq.' + enc(schoolId) + '&select=id,name,category') || [];
  const headById = {};
  heads.forEach(h => { headById[h.id] = h; });

  let structure = await sb('GET', 'fee_structure?school_id=eq.' + enc(schoolId) + '&class=eq.' + enc(stu.class) + '&select=*') || [];
  structure = structure.map(s => Object.assign({}, s, { period_amounts: parseJson(s.period_amounts, null) }));

  let overrides = [];
  try {
    overrides = await sb('GET', 'student_fee_overrides?student_id=eq.' + enc(studentId) + '&school_id=eq.' + enc(schoolId) + '&select=fee_head_id,total_amount,note') || [];
  } catch (e) { overrides = []; }
  // Same spreading rule as applyStudentOverrides() in fee.html
  overrides.forEach(ov => {
    const s = structure.find(x => x.fee_head_id === ov.fee_head_id);
    if (!s) return;
    const customTotal = parseFloat(ov.total_amount) || 0;
    s.total_amount = customTotal;
    if (s.period_amounts && typeof s.period_amounts === 'object') {
      const keys = Object.keys(s.period_amounts).filter(k => (parseFloat(s.period_amounts[k]) || 0) > 0);
      const useKeys = keys.length > 0 ? keys : periods;
      const even = useKeys.length > 0 ? Math.round((customTotal / useKeys.length) * 100) / 100 : customTotal;
      const pa = {};
      useKeys.forEach(k => { pa[k] = even; });
      s.period_amounts = pa;
    }
    if (s.annual_amount) s.annual_amount = customTotal;
  });

  const payments = await sb('GET', 'fee_payments?student_id=eq.' + enc(studentId) + '&school_id=eq.' + enc(schoolId) +
    '&is_cancelled=not.is.true&select=fee_head_id,period,amount_paid') || [];
  const paidMap = {};
  const lateFeePaid = {};
  payments.forEach(p => {
    const amt = parseFloat(p.amount_paid) || 0;
    if (p.fee_head_id === LATE_FEE_ID) { lateFeePaid[p.period] = (lateFeePaid[p.period] || 0) + amt; return; }
    const key = p.fee_head_id + '_' + p.period;
    paidMap[key] = (paidMap[key] || 0) + amt;
  });

  let scheme = null;
  try {
    scheme = (await sb('GET', 'scheme_enrollments?student_id=eq.' + enc(studentId) + '&school_id=eq.' + enc(schoolId) +
      '&status=eq.active&select=free_van,free_uniform,free_books&limit=1') || [])[0] || null;
  } catch (e) { scheme = null; }

  function isSchemeFree(headId) {
    if (!scheme) return false;
    const h = headById[headId];
    if (!h) return false;
    if (h.category === 'transport') return !!scheme.free_van;
    if (h.category === 'uniform') return !!scheme.free_uniform;
    if (h.category === 'books') return !!scheme.free_books;
    return !h.category || h.category === 'general';
  }
  function isRteFree(headId) {
    if (!stu.is_rte) return false;
    const h = headById[headId];
    if (!h) return false;
    return !h.category || h.category === 'general';
  }
  const isPerPeriodRow = s => !!(s && s.period_amounts && Object.keys(s.period_amounts).length > 0);
  function amountForPeriod(s, p) {
    if (isPerPeriodRow(s)) return parseFloat(s.period_amounts[p]) || 0;
    return p === periods[0] ? (parseFloat(s.annual_amount) || 0) : 0;
  }
  function paidForPeriod(s, p) {
    const key = s.fee_head_id + '_';
    if (isPerPeriodRow(s)) return paidMap[key + p] || 0;
    if (p !== periods[0]) return 0;
    let t = 0;
    Object.keys(paidMap).forEach(k => { if (k.indexOf(key) === 0) t += paidMap[k]; });
    return t;
  }

  const items = [];
  const pendingByPeriod = {};

  // ── Class fee heads ──
  structure.forEach(s => {
    const h = headById[s.fee_head_id];
    if (h && h.category === 'transport') return;           // van handled below
    if (!stu.is_rte && h && h.category === 'rte') return;  // RTE fee only for RTE students
    if (isRteFree(s.fee_head_id) || isSchemeFree(s.fee_head_id)) return;
    periods.forEach(p => {
      const amt = amountForPeriod(s, p);
      if (amt <= 0) return;
      const bal = money(amt - paidForPeriod(s, p));
      if (bal <= 0) return;
      pendingByPeriod[p] = (pendingByPeriod[p] || 0) + bal;
      const name = s.fee_head_name || (h && h.name) || 'Fee';
      items.push({
        key: 'fee|' + s.fee_head_id + '|' + p, group: 'fee', fee_head_id: s.fee_head_id,
        fee_head_name: name, period: p, label: name + ' · ' + (isPerPeriodRow(s) ? p : 'Full year'), amount: bal
      });
    });
  });

  // ── Van ──
  let van = null;
  try {
    van = (await sb('GET', 'student_transport?student_id=eq.' + enc(studentId) + '&select=*&limit=1') || [])[0] || null;
  } catch (e) { van = null; }
  const vanHead = heads.find(h => h.category === 'transport') || null;
  if (van && vanHead && !(scheme && scheme.free_van)) {
    const d = istToday();
    const vy = d.getUTCMonth() >= 5 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
    const currentVanYear = vy + '-' + String((vy + 1) % 100).padStart(2, '0');
    const vanName = vanHead.name || 'Van Fee';
    if (van.van_plan === 'one_time' && van.van_plan_year === currentVanYear) {
      const planAmt = parseFloat(van.van_plan_amount) || 0;
      const bal = money(planAmt - (paidMap[vanHead.id + '_' + VAN_ONETIME_PERIOD] || 0));
      if (bal > 0) items.push({ key: 'van|' + VAN_ONETIME_PERIOD, group: 'van', fee_head_id: vanHead.id, fee_head_name: vanName, period: VAN_ONETIME_PERIOD, label: vanName + ' · One-time plan ' + currentVanYear, amount: bal });
    } else {
      const rate = parseFloat(van.monthly_fee) || 0;
      // Months charged — a mid-year joiner starts from the joining month
      let months = vanMonths.slice();
      if (months.length && stu.admission_date) {
        const adm = new Date(String(stu.admission_date).slice(0, 10) + 'T00:00:00Z');
        const startIdx = MONTHS.indexOf(months[0]);
        if (!isNaN(adm.getTime()) && startIdx !== -1) {
          let ys = new Date(Date.UTC(d.getUTCFullYear(), startIdx, 1));
          if (ys > d) ys = new Date(Date.UTC(d.getUTCFullYear() - 1, startIdx, 1));
          if (adm >= ys) {
            const pos = months.indexOf(MONTHS[adm.getUTCMonth()]);
            if (pos > 0) months = months.slice(pos);
          }
        }
      }
      if (rate > 0) months.forEach(m => {
        const bal = money(rate - (paidMap[vanHead.id + '_' + m] || 0));
        if (bal > 0) items.push({ key: 'van|' + m, group: 'van', fee_head_id: vanHead.id, fee_head_name: vanName, period: m, label: vanName + ' · ' + m, amount: bal });
      });
    }
  }

  // ── Late fees (per overdue period, same rules as the counter) ──
  function periodDueDate(p) {
    if (collectionMode === 'term') {
      const t = termConfig.find(x => x.name === p);
      return (t && t.due) ? t.due : null;
    }
    if (collectionMode === 'month') {
      const mi = MONTHS.indexOf(p);
      if (mi < 0) return null;
      const d = istToday();
      let startYear = d.getUTCFullYear();
      if (d.getUTCMonth() < monthStart) startYear -= 1;
      const year = mi >= monthStart ? startYear : startYear + 1;
      const day = Math.min(Math.max(lateCfg.due_day || 10, 1), 28);
      return year + '-' + String(mi + 1).padStart(2, '0') + '-' + String(day).padStart(2, '0');
    }
    return null;
  }
  if (lateCfg.enabled) {
    Object.keys(pendingByPeriod).forEach(p => {
      const due = periodDueDate(p);
      if (!due) return;
      const dueD = new Date(String(due).slice(0, 10) + 'T00:00:00Z');
      if (isNaN(dueD.getTime())) return;
      const overdue = Math.floor((istToday() - dueD) / 86400000);
      const late = overdue - (lateCfg.grace_days || 0);
      if (late <= 0) return;
      const base = lateCfg.mode === 'percent' ? (pendingByPeriod[p] * (lateCfg.amount || 0)) / 100 : (lateCfg.amount || 0);
      if (base <= 0) return;
      let units = 1;
      if (lateCfg.frequency === 'daily') units = late;
      if (lateCfg.frequency === 'weekly') units = Math.ceil(late / 7);
      if (lateCfg.frequency === 'monthly') units = Math.ceil(late / 30);
      let fine = Math.round(base * units);
      if (lateCfg.max_amount > 0 && fine > lateCfg.max_amount) fine = lateCfg.max_amount;
      fine = Math.max(0, fine - (lateFeePaid[p] || 0));
      if (fine > 0) items.push({ key: 'late|' + p, group: 'late', fee_head_id: LATE_FEE_ID, fee_head_name: LATE_FEE_NAME, period: p, label: LATE_FEE_NAME + ' · ' + p + ' (' + overdue + ' days past due)', amount: fine, is_late_fee: true });
    });
  }

  return { student: stu, items };
}

module.exports = { computeDues, LATE_FEE_ID, LATE_FEE_NAME, VAN_ONETIME_PERIOD };
