const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { db } = require('../app/db');
const { flash, requireAdmin } = require('../app/middleware');
const { slugify } = require('../app/helpers');

router.use(requireAdmin);

// ============ Dashboard ============
router.get('/', (req, res) => {
  const stats = {
    users: db.prepare("SELECT COUNT(*) c FROM users WHERE role = 'user'").get().c,
    invitations: db.prepare('SELECT COUNT(*) c FROM invitations').get().c,
    published: db.prepare("SELECT COUNT(*) c FROM invitations WHERE status = 'published'").get().c,
    guests: db.prepare('SELECT COUNT(*) c FROM guests').get().c,
    rsvps: db.prepare('SELECT COUNT(*) c FROM rsvps').get().c,
    wishes: db.prepare('SELECT COUNT(*) c FROM wishes').get().c,
    themes: db.prepare('SELECT COUNT(*) c FROM themes').get().c,
  };
  const latestUsers = db.prepare('SELECT * FROM users ORDER BY id DESC LIMIT 5').all();
  const latestInvs = db.prepare(
    `SELECT i.*, u.name AS owner_name, u.email AS owner_email FROM invitations i JOIN users u ON u.id = i.user_id ORDER BY i.id DESC LIMIT 5`
  ).all();
  res.render('admin/dashboard', { title: 'Dashboard Admin', active: 'dashboard', stats, latestUsers, latestInvs });
});

// ============ Pengguna ============
router.get('/pengguna', (req, res) => {
  const q = String(req.query.q || '').trim();
  const users = q
    ? db.prepare('SELECT * FROM users WHERE name LIKE ? OR email LIKE ? ORDER BY id DESC').all(`%${q}%`, `%${q}%`)
    : db.prepare('SELECT * FROM users ORDER BY id DESC').all();
  res.render('admin/users', { title: 'Pengguna', active: 'users', users, q });
});

router.get('/pengguna/baru', (req, res) => {
  res.render('admin/user-form', { title: 'Tambah Pengguna', active: 'users', user: null });
});

router.post('/pengguna', (req, res) => {
  const { name, email, password, phone, role } = req.body;
  if (!name || !email || !password || password.length < 6) {
    flash(req, 'error', 'Nama, email, dan kata sandi (min. 6 karakter) wajib diisi.');
    return res.redirect('/admin/pengguna/baru');
  }
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email.trim().toLowerCase())) {
    flash(req, 'error', 'Email sudah terdaftar.');
    return res.redirect('/admin/pengguna/baru');
  }
  db.prepare('INSERT INTO users (name, email, password, phone, role) VALUES (?, ?, ?, ?, ?)').run(
    name.trim(), email.trim().toLowerCase(), bcrypt.hashSync(password, 10), (phone || '').trim(),
    role === 'admin' ? 'admin' : 'user'
  );
  flash(req, 'success', 'Pengguna ditambahkan.');
  res.redirect('/admin/pengguna');
});

router.get('/pengguna/:id/edit', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) {
    flash(req, 'error', 'Pengguna tidak ditemukan.');
    return res.redirect('/admin/pengguna');
  }
  res.render('admin/user-form', { title: 'Edit Pengguna', active: 'users', user });
});

router.put('/pengguna/:id', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.redirect('/admin/pengguna');
  const { name, email, phone, role, password } = req.body;
  if (!name || !email) {
    flash(req, 'error', 'Nama dan email wajib diisi.');
    return res.redirect(`/admin/pengguna/${user.id}/edit`);
  }
  const taken = db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(email.trim().toLowerCase(), user.id);
  if (taken) {
    flash(req, 'error', 'Email sudah dipakai pengguna lain.');
    return res.redirect(`/admin/pengguna/${user.id}/edit`);
  }
  db.prepare('UPDATE users SET name = ?, email = ?, phone = ?, role = ? WHERE id = ?').run(
    name.trim(), email.trim().toLowerCase(), (phone || '').trim(), role === 'admin' ? 'admin' : 'user', user.id
  );
  if (password) {
    if (password.length < 6) {
      flash(req, 'error', 'Kata sandi baru minimal 6 karakter — data lain sudah tersimpan.');
      return res.redirect(`/admin/pengguna/${user.id}/edit`);
    }
    db.prepare('UPDATE users SET password = ? WHERE id = ?').run(bcrypt.hashSync(password, 10), user.id);
  }
  flash(req, 'success', 'Data pengguna tersimpan.');
  res.redirect('/admin/pengguna');
});

router.post('/pengguna/:id/status', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.redirect('/admin/pengguna');
  if (user.id === req.session.user.id) {
    flash(req, 'error', 'Tidak bisa menonaktifkan akun sendiri.');
    return res.redirect('/admin/pengguna');
  }
  db.prepare('UPDATE users SET is_active = 1 - is_active WHERE id = ?').run(user.id);
  flash(req, 'success', `Akun ${user.name} ${user.is_active ? 'dinonaktifkan' : 'diaktifkan'}.`);
  res.redirect('/admin/pengguna');
});

router.delete('/pengguna/:id', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.redirect('/admin/pengguna');
  if (user.id === req.session.user.id) {
    flash(req, 'error', 'Tidak bisa menghapus akun sendiri.');
    return res.redirect('/admin/pengguna');
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
  flash(req, 'success', `Pengguna ${user.name} beserta seluruh undangannya dihapus.`);
  res.redirect('/admin/pengguna');
});

// ============ Undangan ============
router.get('/undangan', (req, res) => {
  const invs = db.prepare(
    `SELECT i.*, u.name AS owner_name, u.email AS owner_email,
            (SELECT COUNT(*) FROM guests g WHERE g.invitation_id = i.id) AS guest_count
     FROM invitations i JOIN users u ON u.id = i.user_id ORDER BY i.id DESC`
  ).all();
  res.render('admin/invitations', { title: 'Semua Undangan', active: 'invitations', invs });
});

router.post('/undangan/:id/status', (req, res) => {
  const inv = db.prepare('SELECT * FROM invitations WHERE id = ?').get(req.params.id);
  if (!inv) return res.redirect('/admin/undangan');
  db.prepare("UPDATE invitations SET status = CASE status WHEN 'published' THEN 'draft' ELSE 'published' END WHERE id = ?").run(inv.id);
  flash(req, 'success', 'Status undangan diubah.');
  res.redirect('/admin/undangan');
});

router.delete('/undangan/:id', (req, res) => {
  const inv = db.prepare('SELECT * FROM invitations WHERE id = ?').get(req.params.id);
  if (!inv) return res.redirect('/admin/undangan');
  db.prepare('DELETE FROM invitations WHERE id = ?').run(inv.id);
  flash(req, 'success', 'Undangan dihapus.');
  res.redirect('/admin/undangan');
});

// ============ Tema ============
router.get('/tema', (req, res) => {
  const themes = db.prepare('SELECT * FROM themes ORDER BY id').all();
  res.render('admin/themes', { title: 'Tema', active: 'themes', themes });
});

router.get('/tema/baru', (req, res) => {
  res.render('admin/theme-form', {
    title: 'Tambah Tema', active: 'themes', theme: null,
    colors: { primary: '#8a6d3b', secondary: '#c9a961', bg: '#faf7f0', text: '#3d3529', accent: '#f3ead9' },
  });
});

router.post('/tema', (req, res) => {
  const { name, description, primary, secondary, bg, text, accent, is_premium, is_active } = req.body;
  if (!name) {
    flash(req, 'error', 'Nama tema wajib diisi.');
    return res.redirect('/admin/tema/baru');
  }
  let slug = slugify(name);
  while (db.prepare('SELECT 1 FROM themes WHERE slug = ?').get(slug)) slug = `${slug}-${Date.now() % 10000}`;
  db.prepare('INSERT INTO themes (name, slug, description, colors, is_premium, is_active) VALUES (?, ?, ?, ?, ?, ?)').run(
    name.trim(), slug, (description || '').trim(),
    JSON.stringify({ primary, secondary, bg, text, accent }),
    is_premium ? 1 : 0, is_active ? 1 : 0
  );
  flash(req, 'success', 'Tema ditambahkan.');
  res.redirect('/admin/tema');
});

router.get('/tema/:id/edit', (req, res) => {
  const theme = db.prepare('SELECT * FROM themes WHERE id = ?').get(req.params.id);
  if (!theme) return res.redirect('/admin/tema');
  const colors = JSON.parse(theme.colors || '{}');
  res.render('admin/theme-form', { title: 'Edit Tema', active: 'themes', theme, colors });
});

router.put('/tema/:id', (req, res) => {
  const theme = db.prepare('SELECT * FROM themes WHERE id = ?').get(req.params.id);
  if (!theme) return res.redirect('/admin/tema');
  const { name, description, primary, secondary, bg, text, accent, is_premium, is_active } = req.body;
  if (!name) {
    flash(req, 'error', 'Nama tema wajib diisi.');
    return res.redirect(`/admin/tema/${theme.id}/edit`);
  }
  db.prepare('UPDATE themes SET name = ?, description = ?, colors = ?, is_premium = ?, is_active = ? WHERE id = ?').run(
    name.trim(), (description || '').trim(),
    JSON.stringify({ primary, secondary, bg, text, accent }),
    is_premium ? 1 : 0, is_active ? 1 : 0, theme.id
  );
  flash(req, 'success', 'Tema diperbarui.');
  res.redirect('/admin/tema');
});

router.delete('/tema/:id', (req, res) => {
  const theme = db.prepare('SELECT * FROM themes WHERE id = ?').get(req.params.id);
  if (!theme) return res.redirect('/admin/tema');
  db.prepare('DELETE FROM themes WHERE id = ?').run(theme.id);
  flash(req, 'success', 'Tema dihapus. Undangan yang memakainya akan kembali tanpa tema.');
  res.redirect('/admin/tema');
});

// ============ Pengaturan situs ============
router.get('/pengaturan', (req, res) => {
  const settings = {};
  db.prepare('SELECT key, value FROM settings').all().forEach((r) => { settings[r.key] = r.value; });
  res.render('admin/settings', { title: 'Pengaturan Situs', active: 'settings', settings });
});

router.post('/pengaturan', (req, res) => {
  const keys = ['site_name', 'site_tagline', 'hero_title', 'hero_subtitle', 'contact_wa', 'footer_note'];
  const upsert = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const k of keys) upsert.run(k, String(req.body[k] || '').trim());
  flash(req, 'success', 'Pengaturan situs tersimpan.');
  res.redirect('/admin/pengaturan');
});

module.exports = router;
