// DigiSmart ERP — Library (Nov 2026)
// Books (title, author, subject, copies), lending to students and staff, returns,
// overdue list, and lost books (copy removed; optionally charged to the child's fees
// as a store bill). No fines. Parents see their child's borrowed book in the parent app
// (api/parent-data.js 'library').
// Owner, or staff with the "Library" module. Needs step-library.sql (and step-store.sql
// for charging a lost book).
//
// POST { token, action, ... }
//   load                                  → books with copies out / available, counts
//   book_save   { book }  / book_delete { id }
//   people      { q }                     → students and staff matching a name
//   issue       { book_id, borrower_type, borrower_id, due_on }
//   return      { loan_id }
//   lost        { loan_id, charge }       → copy removed; charge ₹ (students) added to fees
//   loans       { show: 'open'|'overdue'|'all', q? }
//   report                                → most borrowed, by class, overdue

const crypto = require('crypto');
const { sb, enc, getServiceKey } = require('./_push');
const { feeYear } = require('./_fees');

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
const int = v => { const n = parseInt(v, 10); return isNaN(n) ? 0 : n; };
const isId = v => /^[0-9a-f-]{36}$/i.test(String(v || ''));
const today = () => new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
const addDays = (d, n) => new Date(new Date(d + 'T00:00:00Z').getTime() + n * 86400000).toISOString().slice(0, 10);
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
  if (!(s.role === 'owner' || mods.indexOf('library') !== -1)) return res.status(403).json({ ok: false, error: 'You do not have permission for the Library.' });
  const schoolId = String(s.sid), sid = enc(schoolId);
  const by = s.name || s.staff_name || s.email || (s.role === 'owner' ? 'Owner' : 'Staff');
  const action = String(body.action || '');

  async function openLoans() { return getAll('library_loans?school_id=eq.' + sid + '&returned_on=is.null&lost=is.false&select=*&order=due_on.asc'); }

  try {
    if (action === 'load') {
      const books = await getAll('library_books?school_id=eq.' + sid + '&select=*&order=title.asc');
      const loans = await openLoans();
      const out = {};
      loans.forEach(l => { out[l.book_id] = (out[l.book_id] || 0) + 1; });
      books.forEach(b => { b.out = out[b.id] || 0; b.available = Math.max(0, int(b.copies) - b.out); });
      const t = today();
      return res.status(200).json({ ok: true, books, open: loans.length, overdue: loans.filter(l => l.due_on < t).length,
        copies: books.reduce((a, b) => a + int(b.copies), 0) });
    }

    if (action === 'book_save') {
      const b = body.book || {};
      const row = { title: str(b.title, 160), author: str(b.author, 100) || null, subject: str(b.subject, 60) || null,
        class_name: str(b.class_name, 30) || null, copies: Math.max(0, int(b.copies) || 1), shelf: str(b.shelf, 40) || null };
      if (!row.title) return res.status(400).json({ ok: false, error: 'Please type the book title.' });
      if (isId(b.id)) await sb('PATCH', 'library_books?id=eq.' + enc(b.id) + '&school_id=eq.' + sid, row, 'return=minimal');
      else await sb('POST', 'library_books', [Object.assign({ school_id: schoolId }, row)], 'return=minimal');
      return res.status(200).json({ ok: true });
    }
    if (action === 'book_delete') {
      const out = await sb('GET', 'library_loans?school_id=eq.' + sid + '&book_id=eq.' + enc(body.id) + '&returned_on=is.null&lost=is.false&select=id&limit=1') || [];
      if (out.length) return res.status(400).json({ ok: false, error: 'A copy of this book is lent out. Take it back first.' });
      await sb('DELETE', 'library_books?id=eq.' + enc(body.id) + '&school_id=eq.' + sid, null, 'return=minimal');
      return res.status(200).json({ ok: true });
    }

    if (action === 'people') {
      const q = str(body.q, 40).replace(/[(),*%]/g, ' ').trim();
      if (q.length < 2) return res.status(200).json({ ok: true, people: [] });
      const st = await sb('GET', 'students?school_id=eq.' + sid + '&status=eq.active&or=(full_name.ilike.*' + enc(q) + '*,admission_no.ilike.*' + enc(q) + '*)' +
        '&select=id,full_name,admission_no,class,section&order=full_name.asc&limit=15') || [];
      const sf = await sb('GET', 'staff?school_id=eq.' + sid + '&status=eq.active&name=ilike.*' + enc(q) + '*&select=id,name,role&order=name.asc&limit=10').catch(() => []) || [];
      return res.status(200).json({ ok: true, people: st.map(x => ({ type: 'student', id: x.id, name: x.full_name, sub: x.class + (x.section ? ' ' + x.section : '') + (x.admission_no ? ' · ' + x.admission_no : '') }))
        .concat(sf.map(x => ({ type: 'staff', id: x.id, name: x.name, sub: 'Staff' + (x.role ? ' · ' + x.role : '') }))) });
    }

    if (action === 'issue') {
      const book = (await sb('GET', 'library_books?id=eq.' + enc(body.book_id) + '&school_id=eq.' + sid + '&select=*&limit=1') || [])[0];
      if (!book) return res.status(404).json({ ok: false, error: 'Book not found.' });
      const out = (await sb('GET', 'library_loans?school_id=eq.' + sid + '&book_id=eq.' + enc(book.id) + '&returned_on=is.null&lost=is.false&select=id') || []).length;
      if (out >= int(book.copies)) return res.status(400).json({ ok: false, error: 'All copies of "' + book.title + '" are lent out.' });
      const type = body.borrower_type === 'staff' ? 'staff' : 'student';
      let who;
      if (type === 'student') {
        const r = (await sb('GET', 'students?id=eq.' + enc(body.borrower_id) + '&school_id=eq.' + sid + '&select=id,full_name,class,section&limit=1') || [])[0];
        if (!r) return res.status(404).json({ ok: false, error: 'Student not found.' });
        who = { student_id: r.id, borrower_name: r.full_name, borrower_class: r.class + (r.section ? ' ' + r.section : '') };
      } else {
        const r = (await sb('GET', 'staff?id=eq.' + enc(body.borrower_id) + '&school_id=eq.' + sid + '&select=id,name,role&limit=1') || [])[0];
        if (!r) return res.status(404).json({ ok: false, error: 'Staff not found.' });
        who = { staff_id: r.id, borrower_name: r.name, borrower_class: 'Staff' };
      }
      const t = today();
      const due = /^\d{4}-\d{2}-\d{2}$/.test(String(body.due_on || '')) && body.due_on >= t ? body.due_on : addDays(t, 14);
      await sb('POST', 'library_loans', [Object.assign({ school_id: schoolId, book_id: book.id, book_title: book.title, borrower_type: type,
        issued_on: t, due_on: due, done_by: by }, who)], 'return=minimal');
      return res.status(200).json({ ok: true, due_on: due });
    }

    if (action === 'return') {
      await sb('PATCH', 'library_loans?id=eq.' + enc(body.loan_id) + '&school_id=eq.' + sid + '&returned_on=is.null', { returned_on: today() }, 'return=minimal');
      return res.status(200).json({ ok: true });
    }

    if (action === 'lost') {
      const loan = (await sb('GET', 'library_loans?id=eq.' + enc(body.loan_id) + '&school_id=eq.' + sid + '&select=*&limit=1') || [])[0];
      if (!loan || loan.returned_on || loan.lost) return res.status(404).json({ ok: false, error: 'Loan not found.' });
      await sb('PATCH', 'library_loans?id=eq.' + enc(loan.id), { lost: true, returned_on: today(), note: 'Lost' }, 'return=minimal');
      const book = (await sb('GET', 'library_books?id=eq.' + enc(loan.book_id) + '&select=id,copies&limit=1') || [])[0];
      if (book) await sb('PATCH', 'library_books?id=eq.' + enc(book.id), { copies: Math.max(0, int(book.copies) - 1) }, 'return=minimal');
      const charge = Math.max(0, Math.round(parseFloat(body.charge) || 0));
      let charged = false;
      if (charge > 0 && loan.student_id) {
        const fy = feeYear((await sb('GET', 'fee_settings?school_id=eq.' + sid + '&select=*&limit=1') || [])[0] || null);
        const d = today().replace(/-/g, '').slice(2);
        await sb('POST', 'store_sales', [{ school_id: schoolId, bill_no: 'L' + d + '-' + crypto.randomBytes(2).toString('hex').toUpperCase(),
          student_id: loan.student_id, student_name: loan.borrower_name, student_class: loan.borrower_class, academic_year: fy,
          items: [{ item_id: null, name: 'Lost library book: ' + loan.book_title, size: '', qty: 1, price: charge, amount: charge }],
          total: charge, done_by: by }], 'return=minimal');
        charged = true;
      }
      return res.status(200).json({ ok: true, charged });
    }

    if (action === 'loans') {
      const show = String(body.show || 'open');
      let path = 'library_loans?school_id=eq.' + sid + '&select=*';
      if (show === 'open' || show === 'overdue') path += '&returned_on=is.null&lost=is.false';
      if (show === 'overdue') path += '&due_on=lt.' + today();
      const rows = await sb('GET', path + '&order=' + (show === 'all' ? 'issued_on.desc' : 'due_on.asc') + '&limit=500') || [];
      return res.status(200).json({ ok: true, loans: rows, today: today() });
    }

    if (action === 'report') {
      const since = addDays(today(), -365);
      const loans = await getAll('library_loans?school_id=eq.' + sid + '&issued_on=gte.' + since + '&select=book_title,borrower_type,borrower_class,returned_on,lost,due_on&order=id');
      const top = {}, byClass = {};
      loans.forEach(l => {
        top[l.book_title] = (top[l.book_title] || 0) + 1;
        const c = l.borrower_type === 'staff' ? 'Staff' : String(l.borrower_class || '').replace(/ [A-Z]$/, '');
        byClass[c] = (byClass[c] || 0) + 1;
      });
      return res.status(200).json({ ok: true, total: loans.length, lost: loans.filter(l => l.lost).length,
        top: Object.keys(top).map(k => ({ title: k, times: top[k] })).sort((a, b) => b.times - a.times).slice(0, 15),
        by_class: Object.keys(byClass).map(k => ({ class_name: k, times: byClass[k] })).sort((a, b) => b.times - a.times) });
    }

    return res.status(400).json({ ok: false, error: 'Unknown action.' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};
