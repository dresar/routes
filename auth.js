const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { db } = require('../app/db');
const { flash } = require('../app/middleware');

router.get('/daftar', (req, res) => {
  if (req.session.user) return res.redirect(req.session.user.role === 'admin' ? '/admin' : '/panel');
  res.render('auth/register', { title: 'Daftar Akun', old: {} });
});

router.post('/daftar', (req, res) => {
  const { name, email, password, phone } = req.body;
  const old = { name, email, phone };

  if (!name || !email || !password) {
    flash(req, 'error', 'Nama, email, dan kata sandi wajib diisi.');
    return res.render('auth/register', { title: 'Daftar Akun', old });
  }
  if (password.length < 6) {
    flash(req, 'error', 'Kata sandi minimal 6 karakter.');
    return res.render('auth/register', { title: 'Daftar Akun', old });
  }
  const exists = db.prepare('SELECT id FROM users WHERE email = ?').get(email.trim().toLowerCase());
  if (exists) {
    flash(req, 'error', 'Email sudah terdaftar. Silakan masuk.');
    return res.render('auth/register', { title: 'Daftar Akun', old });
  }

  const hash = bcrypt.hashSync(password, 10);
  const info = db
    .prepare('INSERT INTO users (name, email, password, phone) VALUES (?, ?, ?, ?)')
    .run(name.trim(), email.trim().toLowerCase(), hash, (phone || '').trim());
  req.session.user = { id: info.lastInsertRowid, name: name.trim(), email: email.trim().toLowerCase(), role: 'user' };
  flash(req, 'success', 'Akun berhasil dibuat. Yuk buat undangan pertamamu!');
  res.redirect('/panel');
});

router.get('/masuk', (req, res) => {
  if (req.session.user) return res.redirect(req.session.user.role === 'admin' ? '/admin' : '/panel');
  res.render('auth/login', { title: 'Masuk', old: {} });
});

router.post('/masuk', (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email || '').trim().toLowerCase());

  if (!user || !bcrypt.compareSync(String(password || ''), user.password)) {
    flash(req, 'error', 'Email atau kata sandi salah.');
    return res.render('auth/login', { title: 'Masuk', old: { email } });
  }
  if (!user.is_active) {
    flash(req, 'error', 'Akun Anda dinonaktifkan. Hubungi admin.');
    return res.redirect('/masuk');
  }

  req.session.user = { id: user.id, name: user.name, email: user.email, role: user.role };
  flash(req, 'success', `Selamat datang kembali, ${user.name}!`);
  res.redirect(user.role === 'admin' ? '/admin' : '/panel');
});

router.get('/keluar', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

module.exports = router;
