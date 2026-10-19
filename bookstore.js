// bookstore.js: bookstore, cart, orders and staff order management (demo, no real payments).
// Every query runs with the logged-in user's own token (req.db), so the RLS rules and
// functions from 001_bookstore.sql decide who can see or change what.
module.exports = function (app, { requireLogin, requireRole, safe }) {
  const student = [requireLogin, requireRole('student')];
  const fail = (res, error, code) => res.status(code || 400).json({ error: error.message });

  const requireStaff = safe(async (req, res, next) => {
    const r = await req.db.rpc('is_staff');
    if (r.error || r.data !== true) {
      return res.status(403).json({ error: 'This section is only for bookstore staff.' });
    }
    next();
  });

  const ORDER_FIELDS = 'order_id, order_no, status, total, ship_name, ship_address, ship_city, ship_state, ship_pin, ' +
    'ship_phone, tracking_ref, estimated_delivery, payment_note, created_at, ' +
    'order_items(title, unit_price, quantity), order_events(status, note, created_at)';

  // ---------- BOOKS ----------
  app.get('/api/books', requireLogin, safe(async (req, res) => {
    const r = await req.db.from('books')
      .select('book_id, title, author, description, cover_url, price, stock')
      .eq('is_active', true).order('book_id');
    if (r.error) return fail(res, r.error, 500);
    res.json(r.data);
  }));

  // ---------- CART (students only; RLS limits every row to the student's own) ----------
  app.get('/api/cart', ...student, safe(async (req, res) => {
    const r = await req.db.from('cart_items')
      .select('book_id, quantity, books(title, price, stock)')
      .eq('student_id', req.profile.student_id).order('book_id');
    if (r.error) return fail(res, r.error, 500);
    const items = r.data.filter((i) => i.books).map((i) => ({
      book_id: i.book_id,
      quantity: i.quantity,
      title: i.books.title,
      price: Number(i.books.price),
      stock: i.books.stock,
      subtotal: Math.round(Number(i.books.price) * i.quantity * 100) / 100
    }));
    const total = Math.round(items.reduce((s, i) => s + i.subtotal, 0) * 100) / 100;
    res.json({ items, total });
  }));

  // Add one copy (change = 1) or remove one copy (change = -1)
  app.post('/api/cart', ...student, safe(async (req, res) => {
    const sid = req.profile.student_id;
    const bookId = Number(req.body.book_id);
    const change = Number(req.body.change);
    if (!Number.isInteger(bookId) || ![1, -1].includes(change)) {
      return res.status(400).json({ error: 'Invalid cart request.' });
    }
    const book = await req.db.from('books').select('book_id, stock, is_active').eq('book_id', bookId).maybeSingle();
    if (book.error) return fail(res, book.error, 500);
    if (!book.data || !book.data.is_active) return res.status(404).json({ error: 'Book not found.' });

    const cur = await req.db.from('cart_items').select('quantity').eq('student_id', sid).eq('book_id', bookId).maybeSingle();
    if (cur.error) return fail(res, cur.error, 500);
    const qty = (cur.data ? cur.data.quantity : 0) + change;

    if (qty < 1) {
      const del = await req.db.from('cart_items').delete().eq('student_id', sid).eq('book_id', bookId);
      if (del.error) return fail(res, del.error);
      return res.json({ message: 'Removed from cart.' });
    }
    if (qty > 10) return res.status(400).json({ error: 'You can order at most 10 copies of one book.' });
    if (qty > book.data.stock) {
      return res.status(400).json({ error: book.data.stock > 0 ? 'Only ' + book.data.stock + ' copies are in stock.' : 'This book is out of stock.' });
    }
    const saved = await req.db.from('cart_items')
      .upsert({ student_id: sid, book_id: bookId, quantity: qty }, { onConflict: 'student_id,book_id' });
    if (saved.error) return fail(res, saved.error);
    res.json({ message: 'Cart updated.', quantity: qty });
  }));

  app.delete('/api/cart/:bookId', ...student, safe(async (req, res) => {
    const bookId = Number(req.params.bookId);
    if (!Number.isInteger(bookId)) return res.status(400).json({ error: 'Invalid book.' });
    const del = await req.db.from('cart_items').delete()
      .eq('student_id', req.profile.student_id).eq('book_id', bookId);
    if (del.error) return fail(res, del.error);
    res.json({ message: 'Removed from cart.' });
  }));

  // ---------- ORDERS (students) ----------
  // The database function checks the details, takes prices from the books table, checks stock,
  // and makes the order, so nothing the browser sends can change prices or totals.
  app.post('/api/orders', ...student, safe(async (req, res) => {
    const b = req.body || {};
    const placed = await req.db.rpc('place_order', {
      p_key: b.key, p_name: b.name, p_address: b.address, p_city: b.city,
      p_state: b.state, p_pin: b.pin, p_phone: b.phone
    });
    if (placed.error) return fail(res, placed.error);
    const o = await req.db.from('orders').select('order_id, order_no, status, total').eq('order_id', placed.data).single();
    if (o.error) return fail(res, o.error, 500);
    res.json(o.data);
  }));

  app.get('/api/orders', ...student, safe(async (req, res) => {
    const r = await req.db.from('orders').select(ORDER_FIELDS).order('created_at', { ascending: false });
    if (r.error) return fail(res, r.error, 500);
    res.json(r.data);
  }));

  app.post('/api/orders/:id/cancel', ...student, safe(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid order.' });
    const r = await req.db.rpc('cancel_order', { p_order_id: id });
    if (r.error) return fail(res, r.error);
    res.json({ message: 'Order cancelled.' });
  }));

  // ---------- STAFF ORDER MANAGEMENT ----------
  app.get('/api/staff/check', requireLogin, requireRole('teacher'), safe(async (req, res) => {
    const r = await req.db.rpc('is_staff');
    res.json({ staff: !r.error && r.data === true });
  }));

  app.get('/api/staff/orders', requireLogin, requireRole('teacher'), requireStaff, safe(async (req, res) => {
    const r = await req.db.from('orders').select(ORDER_FIELDS).order('created_at', { ascending: false }).limit(200);
    if (r.error) return fail(res, r.error, 500);
    res.json(r.data);
  }));

  app.post('/api/staff/orders/:id', requireLogin, requireRole('teacher'), requireStaff, safe(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid order.' });
    const b = req.body || {};
    const r = await req.db.rpc('staff_update_order', {
      p_order_id: id,
      p_status: b.status,
      p_tracking: String(b.tracking_ref || '').slice(0, 60),
      p_eta: b.estimated_delivery || null,
      p_note: String(b.note || '').slice(0, 300)
    });
    if (r.error) return fail(res, r.error);
    res.json({ message: 'Order updated.' });
  }));
};