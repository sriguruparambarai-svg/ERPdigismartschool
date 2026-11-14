// DigiSmart ERP — Store & Stock (Nov 2026)
// Books, workbooks, notebooks, stationery and uniforms the school gives children
// (each bill becomes a fee item until paid — at the counter, online, in reminders and
// the parent app), plus the school's own supplies (stock only). Class-wise sets give a
// child — or a whole class — everything in one click. Stock goes down by itself.
// Owner, or staff with the "Store & Stock" module. Needs step-store.sql.
//
// POST { token, action, ... }
//   load                                   → items, sets, classes
//   item_save   { item }                   → add / change an item (not its stock)
//   stock_in    { item_id, qty, cost?, note? }   received from the supplier
//   use         { item_id, qty, note? }    school's own use (supplies)
//   adjust      { item_id, stock, note }   correct the count after checking the shelf
//   set_save    { set } / set_delete { id }
//   find        { q }                      → students by name / admission no / class
//   student     { student_id }             → child + this year's bills + the class set
//   sell        { student_id, lines: [{ item_id, qty }], set_id? }
//   sell_class  { class_name, set_id }     → the set to every child in the class who has not had it
//   cancel      { sale_id }                → stock back (only if nothing was paid on it)
//   sales       { from?, to? }             → this year's bills
//   report                                 → stock value, low stock, sold per item, set coverage

const crypto = require('crypto');
const { sb, enc, getServiceKey } = require('./_push');
const { feeYear, STORE_ID, storePeriod } = require('./_fees');

const CATS = ['books', 'notebooks', 'stationery', 'uniform', 'supplies'];

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
const str = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
const num = v => { const n = parseFloat(v); return isNaN(n) ? 0 : Math.round(n * 100) / 100; };
const int = v => { const n = parseInt(v, 10); return isNaN(n) ? 0 : n; };
const isId = v => /^[0-9a-f-]{36}$/i.test(String(v || ''));
function billNo() {
  const d = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString();
  return 'S' + d.slice(2, 4) + d.slice(5, 7) + d.slice(8, 10) + '-' + crypto.randomBytes(2).toString('hex').toUpperCase();
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

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  if (!getServiceKey()) return res.status(500).json({ ok: false, error: 'Server key not configured.' });
  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); }
  catch (e) { return res.status(400).json({ ok: false, error: 'Invalid request.' }); }
  const s = verifyToken(body.token);
  if (!s || !s.sid) return res.status(401).json({ ok: false, error: 'Session expired. Please log in again.' });
  const mods = Array.isArray(s.mods) ? s.mods : [];
  if (!(s.role === 'owner' || mods.indexOf('store') !== -1)) return res.status(403).json({ ok: false, error: 'You do not have permission for Store & Stock.' });
  const schoolId = String(s.sid), sid = enc(schoolId);
  const by = s.name || s.staff_name || s.email || (s.role === 'owner' ? 'Owner' : 'Staff');
  const action = String(body.action || '');

  async function item(id) { return (await sb('GET', 'store_items?id=eq.' + enc(id) + '&school_id=eq.' + sid + '&select=*&limit=1') || [])[0] || null; }
  async function setStock(it, delta, kind, extra) {
    const fresh = await item(it.id);
    const stock = (fresh ? int(fresh.stock) : int(it.stock)) + delta;
    await sb('PATCH', 'store_items?id=eq.' + enc(it.id) + '&school_id=eq.' + sid, { stock }, 'return=minimal');
    await sb('POST', 'store_moves', [Object.assign({ school_id: schoolId, item_id: it.id, item_name: it.name + (it.size ? ' (' + it.size + ')' : ''),
      kind, qty: delta, done_by: by }, extra || {})], 'return=minimal');
    return stock;
  }
  async function year() {
    return feeYear((await sb('GET', 'fee_settings?school_id=eq.' + sid + '&select=*&limit=1') || [])[0] || null);
  }
  // One bill for one child. lines: [{ item_id, qty }]
  async function sellTo(stu, lines, setId, fy, itemsById) {
    const out = [];
    let total = 0;
    for (const l of lines) {
      const it = itemsById[l.item_id];
      const qty = Math.max(1, int(l.qty));
      if (!it) throw new Error('An item was not found.');
      if (!it.for_sale) throw new Error(it.name + ' is a school supply, not for sale.');
      const amount = num(qty * num(it.price));
      out.push({ item_id: it.id, name: it.name, size: it.size || '', qty, price: num(it.price), amount });
      total += amount;
    }
    let sale = null;
    for (let tries = 0; tries < 3 && !sale; tries++) {
      try {
        sale = (await sb('POST', 'store_sales', [{ school_id: schoolId, bill_no: billNo(), student_id: stu.id, student_name: stu.full_name,
          student_class: stu.class + (stu.section ? ' ' + stu.section : ''), academic_year: fy, items: out, total: num(total),
          set_id: setId || null, done_by: by }], 'return=representation') || [])[0];
      } catch (e) { if (!/duplicate|unique/i.test(String(e.message))) throw e; }
    }
    if (!sale) throw new Error('Could not make the bill. Please try again.');
    for (const l of out) {
      const it = itemsById[l.item_id];
      it.stock = await setStock(it, -l.qty, 'issue', { unit_price: l.price, student_id: stu.id, student_name: stu.full_name, sale_id: sale.id });
    }
    return sale;
  }

  try {
    if (action === 'load') {
      const items = await getAll('store_items?school_id=eq.' + sid + '&select=*&order=category.asc,name.asc,size.asc');
      const sets = await sb('GET', 'store_sets?school_id=eq.' + sid + '&select=*&order=class_name.asc') || [];
      const cls = await getAll('students?school_id=eq.' + sid + '&status=eq.active&select=class&order=class.asc');
      const classes = Array.from(new Set(cls.map(c => c.class).filter(Boolean)));
      return res.status(200).json({ ok: true, items, sets, classes, fee_year: await year() });
    }

    if (action === 'item_save') {
      const it = body.item || {};
      const row = { name: str(it.name, 120), category: CATS.indexOf(it.category) !== -1 ? it.category : 'books', size: str(it.size, 20) || null,
        class_name: str(it.class_name, 30) || null, price: num(it.price), cost: num(it.cost), min_stock: Math.max(0, int(it.min_stock)),
        for_sale: it.category === 'supplies' ? false : it.for_sale !== false, active: it.active !== false };
      if (!row.name) return res.status(400).json({ ok: false, error: 'Please type the item name.' });
      if (isId(it.id)) {
        await sb('PATCH', 'store_items?id=eq.' + enc(it.id) + '&school_id=eq.' + sid, row, 'return=minimal');
        return res.status(200).json({ ok: true, item: await item(it.id) });
      }
      const saved = (await sb('POST', 'store_items', [Object.assign({ school_id: schoolId, stock: 0 }, row)], 'return=representation') || [])[0];
      const opening = Math.max(0, int(it.stock));
      if (saved && opening) await setStock(saved, opening, 'in', { note: 'Opening stock', unit_price: row.cost });
      return res.status(200).json({ ok: true, item: await item(saved.id) });
    }

    if (action === 'stock_in' || action === 'use' || action === 'adjust') {
      const it = await item(body.item_id);
      if (!it) return res.status(404).json({ ok: false, error: 'Item not found.' });
      if (action === 'adjust') {
        const target = Math.max(0, int(body.stock));
        const delta = target - int(it.stock);
        if (!delta) return res.status(200).json({ ok: true, item: it });
        await setStock(it, delta, 'adjust', { note: str(body.note, 200) || 'Counted on the shelf' });
      } else {
        const qty = Math.max(0, int(body.qty));
        if (!qty) return res.status(400).json({ ok: false, error: 'Please type how many.' });
        if (action === 'stock_in') {
          if (num(body.cost) > 0) await sb('PATCH', 'store_items?id=eq.' + enc(it.id) + '&school_id=eq.' + sid, { cost: num(body.cost) }, 'return=minimal');
          await setStock(it, qty, 'in', { note: str(body.note, 200) || 'Received', unit_price: num(body.cost) || num(it.cost) });
        } else {
          if (qty > int(it.stock)) return res.status(400).json({ ok: false, error: 'Only ' + int(it.stock) + ' in stock.' });
          await setStock(it, -qty, 'use', { note: str(body.note, 200) || 'School use' });
        }
      }
      return res.status(200).json({ ok: true, item: await item(it.id) });
    }

    if (action === 'set_save') {
      const st = body.set || {};
      const items = (Array.isArray(st.items) ? st.items : []).filter(x => isId(x.item_id)).map(x => ({ item_id: x.item_id, qty: Math.max(1, int(x.qty)) })).slice(0, 60);
      const row = { class_name: str(st.class_name, 30), name: str(st.name, 80) || (str(st.class_name, 30) + ' set'), items };
      if (!row.class_name || !items.length) return res.status(400).json({ ok: false, error: 'Choose the class and at least one item.' });
      if (isId(st.id)) await sb('PATCH', 'store_sets?id=eq.' + enc(st.id) + '&school_id=eq.' + sid, row, 'return=minimal');
      else await sb('POST', 'store_sets', [Object.assign({ school_id: schoolId }, row)], 'return=minimal');
      return res.status(200).json({ ok: true });
    }
    if (action === 'set_delete') {
      await sb('DELETE', 'store_sets?id=eq.' + enc(body.id) + '&school_id=eq.' + sid, null, 'return=minimal');
      return res.status(200).json({ ok: true });
    }

    if (action === 'find') {
      const q = str(body.q, 40).replace(/[(),*%]/g, ' ').trim();
      if (q.length < 2) return res.status(200).json({ ok: true, students: [] });
      const rows = await sb('GET', 'students?school_id=eq.' + sid + '&status=eq.active&or=(full_name.ilike.*' + enc(q) + '*,admission_no.ilike.*' + enc(q) + '*)' +
        '&select=id,full_name,admission_no,class,section&order=full_name.asc&limit=20') || [];
      return res.status(200).json({ ok: true, students: rows });
    }

    if (action === 'student') {
      if (!isId(body.student_id)) return res.status(400).json({ ok: false, error: 'Choose a student.' });
      const stu = (await sb('GET', 'students?id=eq.' + enc(body.student_id) + '&school_id=eq.' + sid + '&select=id,full_name,admission_no,class,section&limit=1') || [])[0];
      if (!stu) return res.status(404).json({ ok: false, error: 'Student not found.' });
      const fy = await year();
      const sales = await sb('GET', 'store_sales?school_id=eq.' + sid + '&student_id=eq.' + enc(stu.id) + '&academic_year=eq.' + enc(fy) + '&select=*&order=created_at.desc') || [];
      const sets = await sb('GET', 'store_sets?school_id=eq.' + sid + '&class_name=eq.' + enc(stu.class) + '&select=*') || [];
      return res.status(200).json({ ok: true, student: stu, sales, sets });
    }

    if (action === 'sell') {
      const stu = (await sb('GET', 'students?id=eq.' + enc(body.student_id) + '&school_id=eq.' + sid + '&select=id,full_name,class,section&limit=1') || [])[0];
      if (!stu) return res.status(404).json({ ok: false, error: 'Student not found.' });
      const lines = (Array.isArray(body.lines) ? body.lines : []).filter(l => isId(l.item_id) && int(l.qty) > 0);
      if (!lines.length) return res.status(400).json({ ok: false, error: 'Add at least one item.' });
      const items = await sb('GET', 'store_items?school_id=eq.' + sid + '&id=in.(' + lines.map(l => enc(l.item_id)).join(',') + ')&select=*') || [];
      const byId = {};
      items.forEach(i => { byId[i.id] = i; });
      const need = {};
      lines.forEach(l => { need[l.item_id] = (need[l.item_id] || 0) + int(l.qty); });
      const short = Object.keys(need).filter(id => byId[id] && int(byId[id].stock) < need[id]).map(id => byId[id].name + (byId[id].size ? ' (' + byId[id].size + ')' : '') + ': only ' + int(byId[id].stock));
      if (short.length && !body.allow_short) return res.status(400).json({ ok: false, short, error: 'Not enough stock — ' + short.join('; ') });
      const sale = await sellTo(stu, lines, isId(body.set_id) ? body.set_id : null, await year(), byId);
      return res.status(200).json({ ok: true, sale });
    }

    if (action === 'sell_class') {
      const set = (await sb('GET', 'store_sets?id=eq.' + enc(body.set_id) + '&school_id=eq.' + sid + '&select=*&limit=1') || [])[0];
      if (!set) return res.status(404).json({ ok: false, error: 'Set not found.' });
      const fy = await year();
      const kids = await getAll('students?school_id=eq.' + sid + '&status=eq.active&class=eq.' + enc(set.class_name) + '&select=id,full_name,class,section&order=full_name.asc');
      const had = new Set((await getAll('store_sales?school_id=eq.' + sid + '&set_id=eq.' + enc(set.id) + '&academic_year=eq.' + enc(fy) + '&cancelled=is.false&select=student_id&order=id')).map(x => String(x.student_id)));
      const todo = kids.filter(k => !had.has(String(k.id)));
      if (!todo.length) return res.status(200).json({ ok: true, done: 0, skipped: kids.length, note: 'Every child in ' + set.class_name + ' already has this set.' });
      const items = await sb('GET', 'store_items?school_id=eq.' + sid + '&id=in.(' + set.items.map(l => enc(l.item_id)).join(',') + ')&select=*') || [];
      const byId = {};
      items.forEach(i => { byId[i.id] = i; });
      const short = set.items.filter(l => byId[l.item_id] && int(byId[l.item_id].stock) < int(l.qty) * todo.length)
        .map(l => byId[l.item_id].name + ': need ' + int(l.qty) * todo.length + ', have ' + int(byId[l.item_id].stock));
      if (short.length && !body.allow_short) return res.status(400).json({ ok: false, short, error: 'Not enough stock for ' + todo.length + ' children — ' + short.join('; ') });
      let done = 0;
      for (const k of todo) { await sellTo(k, set.items, set.id, fy, byId); done++; }
      return res.status(200).json({ ok: true, done, skipped: kids.length - todo.length });
    }

    if (action === 'cancel') {
      const sale = (await sb('GET', 'store_sales?id=eq.' + enc(body.sale_id) + '&school_id=eq.' + sid + '&select=*&limit=1') || [])[0];
      if (!sale || sale.cancelled) return res.status(404).json({ ok: false, error: 'Bill not found.' });
      const paid = await sb('GET', 'fee_payments?school_id=eq.' + sid + '&student_id=eq.' + enc(sale.student_id) + '&fee_head_id=eq.' + STORE_ID +
        '&period=eq.' + enc(storePeriod(sale.bill_no)) + '&is_cancelled=not.is.true&select=id&limit=1') || [];
      if (paid.length) return res.status(400).json({ ok: false, error: 'This bill has a payment. Cancel the fee receipt first.' });
      for (const l of (sale.items || [])) {
        const it = await item(l.item_id);
        if (it) await setStock(it, int(l.qty), 'return', { note: 'Bill ' + sale.bill_no + ' cancelled', student_id: sale.student_id, student_name: sale.student_name, sale_id: sale.id });
      }
      await sb('PATCH', 'store_sales?id=eq.' + enc(sale.id), { cancelled: true }, 'return=minimal');
      return res.status(200).json({ ok: true });
    }

    if (action === 'sales') {
      const fy = await year();
      let q = 'store_sales?school_id=eq.' + sid + '&academic_year=eq.' + enc(fy) + '&select=*&order=created_at.desc';
      if (/^\d{4}-\d{2}-\d{2}$/.test(String(body.from || ''))) q += '&created_at=gte.' + body.from;
      if (/^\d{4}-\d{2}-\d{2}$/.test(String(body.to || ''))) q += '&created_at=lt.' + new Date(new Date(body.to + 'T00:00:00Z').getTime() + 86400000).toISOString().slice(0, 10);
      const rows = await sb('GET', q + '&limit=500') || [];
      // paid or not, per bill
      const paid = {};
      const pays = await getAll('fee_payments?school_id=eq.' + sid + '&fee_head_id=eq.' + STORE_ID + '&is_cancelled=not.is.true&select=student_id,period,amount_paid&order=id');
      pays.forEach(p => { const k = p.student_id + '|' + p.period; paid[k] = (paid[k] || 0) + num(p.amount_paid); });
      rows.forEach(r => { r.paid = paid[r.student_id + '|' + storePeriod(r.bill_no)] || 0; });
      return res.status(200).json({ ok: true, sales: rows, fee_year: fy });
    }

    if (action === 'report') {
      const fy = await year();
      const items = await getAll('store_items?school_id=eq.' + sid + '&active=is.true&select=*&order=name.asc');
      const sales = await getAll('store_sales?school_id=eq.' + sid + '&academic_year=eq.' + enc(fy) + '&cancelled=is.false&select=student_id,set_id,items,total&order=id');
      const sold = {};
      sales.forEach(sl => (sl.items || []).forEach(l => {
        const k = l.item_id;
        if (!sold[k]) sold[k] = { qty: 0, amount: 0 };
        sold[k].qty += int(l.qty); sold[k].amount += num(l.amount);
      }));
      const sets = await sb('GET', 'store_sets?school_id=eq.' + sid + '&select=id,class_name,name') || [];
      const kids = await getAll('students?school_id=eq.' + sid + '&status=eq.active&select=class&order=id');
      const perClass = {};
      kids.forEach(k => { perClass[k.class] = (perClass[k.class] || 0) + 1; });
      const coverage = sets.map(st => ({ set: st.name, class_name: st.class_name, children: perClass[st.class_name] || 0,
        given: new Set(sales.filter(x => x.set_id === st.id).map(x => String(x.student_id))).size }));
      return res.status(200).json({ ok: true, fee_year: fy,
        stock_value: Math.round(items.reduce((a, i) => a + int(i.stock) * num(i.cost), 0)),
        sale_value: Math.round(items.filter(i => i.for_sale).reduce((a, i) => a + int(i.stock) * num(i.price), 0)),
        low: items.filter(i => int(i.stock) <= int(i.min_stock)).map(i => ({ name: i.name, size: i.size, stock: int(i.stock), min_stock: int(i.min_stock) })),
        sold: items.filter(i => sold[i.id]).map(i => ({ name: i.name, size: i.size, qty: sold[i.id].qty, amount: Math.round(sold[i.id].amount) })),
        billed: Math.round(sales.reduce((a, x) => a + num(x.total), 0)), coverage });
    }

    return res.status(400).json({ ok: false, error: 'Unknown action.' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};
