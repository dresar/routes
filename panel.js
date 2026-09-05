const router = require('express').Router();
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { db } = require('../app/db');
const { flash, requireAuth } = require('../app/middleware');
const { slugify, randomToken } = require('../app/helpers');
const { uploadSingle, uploadMany } = require('../app/upload');

router.use(requireAuth);

const INV_FIELDS = [
  'title', 'livestream_url', 'gift_address',
  'groom_nickname', 'groom_fullname', 'groom_parents', 'groom_instagram', 'groom_order',
  'bride_nickname', 'bride_fullname', 'bride_parents', 'bride_instagram', 'bride_order',
];

/** Ambil undangan milik user yang login (atau admin). Null = sudah diredirect. */
function ownedInvitation(req, res) {
  const inv = db.prepare('SELECT * FROM invitations WHERE id = ?').get(req.params.id);
  const ok = inv && (inv.user_id === req.session.user.id || req.session.user.role === 'admin');
  if (!ok) {
    flash(req, 'error', 'Undangan tidak ditemukan atau bukan milik Anda.');
    res.redirect('/panel/undangan');
    return null;
  }
  return inv;
}

/** Ambil baris anak (events/stories/dll) beserta cek kepemilikan undangan induknya. */
function ownedChild(req, res, table) {
  const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(req.params.id);
  if (!row) {
    flash(req, 'error', 'Data tidak ditemukan.');
    res.redirect('/panel/undangan');
    return null;
  }
  const inv = db.prepare('SELECT id, user_id FROM invitations WHERE id = ?').get(row.invitation_id);
  if (!inv || (inv.user_id !== req.session.user.id && req.session.user.role !== 'admin')) {
    flash(req, 'error', 'Anda tidak berhak mengubah data ini.');
    res.redirect('/panel/undangan');
    return null;
  }
  row._invitation_id = inv.id;
  return row;
}

function deleteUpload(file) {
  if (!file || !file.startsWith('/uploads/')) return;
  const p = path.join(__dirname, '..', 'public', file);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

// ============ Dashboard ============
router.get('/', (req, res) => {
  const uid = req.session.user.id;
  const invs = db.prepare('SELECT * FROM invitations WHERE user_id = ? ORDER BY id DESC').all(uid);
  const ids = invs.map((i) => i.id);
  const inClause = ids.length ? ids.join(',') : '0';
  const stats = {
    invitations: invs.length,
    published: invs.filter((i) => i.status === 'published').length,
    guests: db.prepare(`SELECT COUNT(*) c FROM guests WHERE invitation_id IN (${inClause})`).get().c,
    rsvps: db.prepare(`SELECT COUNT(*) c FROM rsvps WHERE invitation_id IN (${inClause})`).get().c,
    wishes: db.prepare(`SELECT COUNT(*) c FROM wishes WHERE invitation_id IN (${inClause})`).get().c,
  };
  res.render('panel/dashboard', { title: 'Dashboard', active: 'dashboard', invs, stats });
});

// ============ Undangan: daftar & buat ============
router.get('/undangan', (req, res) => {
  const invs = db.prepare('SELECT * FROM invitations WHERE user_id = ? ORDER BY id DESC').all(req.session.user.id);
  res.render('panel/invitations', { title: 'Undangan Saya', active: 'undangan', invs });
});

router.get('/undangan/baru', (req, res) => {
  res.render('panel/invitation-form', { title: 'Buat Undangan', active: 'undangan', inv: null, isCreate: true });
});

router.post('/undangan', (req, res) => {
  const { groom_nickname, bride_nickname } = req.body;
  if (!groom_nickname || !bride_nickname) {
    flash(req, 'error', 'Nama panggilan kedua mempelai wajib diisi.');
    return res.redirect('/panel/undangan/baru');
  }
  const base = slugify(`${groom_nickname}-${bride_nickname}`) || 'undangan';
  let slug = base;
  while (db.prepare('SELECT 1 FROM invitations WHERE slug = ?').get(slug)) slug = `${base}-${randomToken(4)}`;

  db.prepare(
    `INSERT INTO invitations (user_id, slug, title, groom_nickname, bride_nickname) VALUES (?, ?, ?, ?, ?)`
  ).run(req.session.user.id, slug, `${groom_nickname} & ${bride_nickname}`, groom_nickname.trim(), bride_nickname.trim());
  const id = db.prepare('SELECT id FROM invitations WHERE slug = ?').get(slug).id;
  flash(req, 'success', 'Undangan dibuat. Lengkapi datanya sekarang!');
  res.redirect(`/panel/undangan/${id}/edit`);
});

// ============ Undangan: form utama (mempelai) ============
router.get('/undangan/:id/edit', (req, res) => {
  const inv = ownedInvitation(req, res);
  if (!inv) return;
  res.render('panel/invitation-form', { title: 'Edit Undangan', active: 'undangan', inv, isCreate: false });
});

router.put('/undangan/:id', (req, res) => {
  const inv = ownedInvitation(req, res);
  if (!inv) return;
  const sets = INV_FIELDS.map((f) => `${f} = ?`).join(', ');
  const vals = INV_FIELDS.map((f) => String(req.body[f] || '').trim());
  db.prepare(`UPDATE invitations SET ${sets}, updated_at = datetime('now') WHERE id = ?`).run(...vals, inv.id);
  flash(req, 'success', 'Data undangan tersimpan.');
  res.redirect(`/panel/undangan/${inv.id}/edit`);
});

router.delete('/undangan/:id', (req, res) => {
  const inv = ownedInvitation(req, res);
  if (!inv) return;
  [inv.cover_photo, inv.groom_photo, inv.bride_photo].forEach(deleteUpload);
  db.prepare('SELECT photo FROM galleries WHERE invitation_id = ?').all(inv.id).forEach((g) => deleteUpload(g.photo));
  db.prepare('DELETE FROM invitations WHERE id = ?').run(inv.id);
  flash(req, 'success', 'Undangan dihapus.');
  res.redirect('/panel/undangan');
});

// ============ Foto mempelai & cover ============
router.post('/undangan/:id/foto/:field', (req, res) => {
  const inv = ownedInvitation(req, res);
  if (!inv) return;
  const field = req.params.field;
  if (!['cover_photo', 'groom_photo', 'bride_photo'].includes(field)) return res.redirect(`/panel/undangan/${inv.id}/edit`);

  uploadSingle(req, res, (err) => {
    if (err || !req.file) {
      flash(req, 'error', err ? err.message : 'Pilih file gambar terlebih dahulu.');
      return res.redirect(`/panel/undangan/${inv.id}/edit`);
    }
    deleteUpload(inv[field]);
    db.prepare(`UPDATE invitations SET ${field} = ?, updated_at = datetime('now') WHERE id = ?`).run(
      `/uploads/${req.file.filename}`, inv.id
    );
    flash(req, 'success', 'Foto diperbarui.');
    res.redirect(`/panel/undangan/${inv.id}/edit`);
  });
});

router.delete('/undangan/:id/foto/:field', (req, res) => {
  const inv = ownedInvitation(req, res);
  if (!inv) return;
  const field = req.params.field;
  if (!['cover_photo', 'groom_photo', 'bride_photo'].includes(field)) return res.redirect(`/panel/undangan/${inv.id}/edit`);
  deleteUpload(inv[field]);
  db.prepare(`UPDATE invitations SET ${field} = '', updated_at = datetime('now') WHERE id = ?`).run(inv.id);
  flash(req, 'success', 'Foto dihapus.');
  res.redirect(`/panel/undangan/${inv.id}/edit`);
});

// ============ Acara ============
router.get('/undangan/:id/acara', (req, res) => {
  const inv = ownedInvitation(req, res);
  if (!inv) return;
  const events = db.prepare('SELECT * FROM events WHERE invitation_id = ? ORDER BY date, start_time').all(inv.id);
  res.render('panel/events', { title: 'Acara', active: 'undangan', inv, events, tab: 'acara' });
});

router.post('/undangan/:id/acara', (req, res) => {
  const inv = ownedInvitation(req, res);
  if (!inv) return;
  const { name, date, start_time, end_time, venue, address, map_url } = req.body;
  if (!name || !date) {
    flash(req, 'error', 'Nama acara dan tanggal wajib diisi.');
    return res.redirect(`/panel/undangan/${inv.id}/acara`);
  }
  const sort = (db.prepare('SELECT MAX(sort) m FROM events WHERE invitation_id = ?').get(inv.id).m || 0) + 1;
  db.prepare('INSERT INTO events (invitation_id, name, date, start_time, end_time, venue, address, map_url, sort) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(inv.id, name.trim(), date, start_time || '', end_time || '', (venue || '').trim(), (address || '').trim(), (map_url || '').trim(), sort);
  flash(req, 'success', 'Acara ditambahkan.');
  res.redirect(`/panel/undangan/${inv.id}/acara`);
});

router.put('/acara/:id', (req, res) => {
  const ev = ownedChild(req, res, 'events');
  if (!ev) return;
  const { name, date, start_time, end_time, venue, address, map_url } = req.body;
  if (!name || !date) {
    flash(req, 'error', 'Nama acara dan tanggal wajib diisi.');
    return res.redirect(`/panel/undangan/${ev._invitation_id}/acara`);
  }
  db.prepare('UPDATE events SET name = ?, date = ?, start_time = ?, end_time = ?, venue = ?, address = ?, map_url = ? WHERE id = ?')
    .run(name.trim(), date, start_time || '', end_time || '', (venue || '').trim(), (address || '').trim(), (map_url || '').trim(), ev.id);
  flash(req, 'success', 'Acara diperbarui.');
  res.redirect(`/panel/undangan/${ev._invitation_id}/acara`);
});

router.delete('/acara/:id', (req, res) => {
  const ev = ownedChild(req, res, 'events');
  if (!ev) return;
  db.prepare('DELETE FROM events WHERE id = ?').run(ev.id);
  flash(req, 'success', 'Acara dihapus.');
  res.redirect(`/panel/undangan/${ev._invitation_id}/acara`);
});

// ============ Galeri ============
router.get('/undangan/:id/galeri', (req, res) => {
  const inv = ownedInvitation(req, res);
  if (!inv) return;
  const photos = db.prepare('SELECT * FROM galleries WHERE invitation_id = ? ORDER BY sort, id').all(inv.id);
  res.render('panel/gallery', { title: 'Galeri', active: 'undangan', inv, photos, tab: 'galeri' });
});

router.post('/undangan/:id/galeri', (req, res) => {
  const inv = ownedInvitation(req, res);
  if (!inv) return;
  uploadMany(req, res, (err) => {
    if (err) {
      flash(req, 'error', err.message);
      return res.redirect(`/panel/undangan/${inv.id}/galeri`);
    }
    if (!req.files || !req.files.length) {
      flash(req, 'error', 'Pilih minimal satu gambar.');
      return res.redirect(`/panel/undangan/${inv.id}/galeri`);
    }
    let sort = db.prepare('SELECT MAX(sort) m FROM galleries WHERE invitation_id = ?').get(inv.id).m || 0;
    const insert = db.prepare('INSERT INTO galleries (invitation_id, photo, caption, sort) VALUES (?, ?, ?, ?)');
    const captions = Array.isArray(req.body.captions) ? req.body.captions : [];
    req.files.forEach((f, i) => insert.run(inv.id, `/uploads/${f.filename}`, (captions[i] || '').trim(), ++sort));
    flash(req, 'success', `${req.files.length} foto ditambahkan ke galeri.`);
    res.redirect(`/panel/undangan/${inv.id}/galeri`);
  });
});

router.delete('/galeri/:id', (req, res) => {
  const row = ownedChild(req, res, 'galleries');
  if (!row) return;
  deleteUpload(row.photo);
  db.prepare('DELETE FROM galleries WHERE id = ?').run(row.id);
  flash(req, 'success', 'Foto dihapus dari galeri.');
  res.redirect(`/panel/undangan/${row._invitation_id}/galeri`);
});

// ============ Cerita cinta ============
router.get('/undangan/:id/cerita', (req, res) => {
  const inv = ownedInvitation(req, res);
  if (!inv) return;
  const stories = db.prepare('SELECT * FROM stories WHERE invitation_id = ? ORDER BY sort, id').all(inv.id);
  res.render('panel/stories', { title: 'Cerita Cinta', active: 'undangan', inv, stories, tab: 'cerita' });
});

router.post('/undangan/:id/cerita', (req, res) => {
  const inv = ownedInvitation(req, res);
  if (!inv) return;
  const { title, date, description } = req.body;
  if (!title) {
    flash(req, 'error', 'Judul cerita wajib diisi.');
    return res.redirect(`/panel/undangan/${inv.id}/cerita`);
  }
  const sort = (db.prepare('SELECT MAX(sort) m FROM stories WHERE invitation_id = ?').get(inv.id).m || 0) + 1;
  db.prepare('INSERT INTO stories (invitation_id, title, date, description, sort) VALUES (?, ?, ?, ?, ?)')
    .run(inv.id, title.trim(), (date || '').trim(), (description || '').trim(), sort);
  flash(req, 'success', 'Cerita ditambahkan.');
  res.redirect(`/panel/undangan/${inv.id}/cerita`);
});

router.put('/cerita/:id', (req, res) => {
  const row = ownedChild(req, res, 'stories');
  if (!row) return;
  const { title, date, description } = req.body;
  db.prepare('UPDATE stories SET title = ?, date = ?, description = ? WHERE id = ?')
    .run((title || '').trim(), (date || '').trim(), (description || '').trim(), row.id);
  flash(req, 'success', 'Cerita diperbarui.');
  res.redirect(`/panel/undangan/${row._invitation_id}/cerita`);
});

router.delete('/cerita/:id', (req, res) => {
  const row = ownedChild(req, res, 'stories');
  if (!row) return;
  db.prepare('DELETE FROM stories WHERE id = ?').run(row.id);
  flash(req, 'success', 'Cerita dihapus.');
  res.redirect(`/panel/undangan/${row._invitation_id}/cerita`);
});

// ============ Amplop digital ============
router.get('/undangan/:id/amplop', (req, res) => {
  const inv = ownedInvitation(req, res);
  if (!inv) return;
  const gifts = db.prepare("SELECT * FROM gifts WHERE type IN ('bank','ewallet') AND invitation_id = ? ORDER BY sort, id").all(inv.id);
  res.render('panel/gifts', { title: 'Amplop Digital', active: 'undangan', inv, gifts, tab: 'amplop' });
});

router.post('/undangan/:id/amplop', (req, res) => {
  const inv = ownedInvitation(req, res);
  if (!inv) return;
  const { type, bank_name, account_number, account_name } = req.body;
  if (!['bank', 'ewallet'].includes(type) || !bank_name || !account_number || !account_name) {
    flash(req, 'error', 'Lengkapi jenis, nama bank/e-wallet, nomor rekening, dan nama pemilik.');
    return res.redirect(`/panel/undangan/${inv.id}/amplop`);
  }
  const sort = (db.prepare('SELECT MAX(sort) m FROM gifts WHERE invitation_id = ?').get(inv.id).m || 0) + 1;
  db.prepare('INSERT INTO gifts (invitation_id, type, bank_name, account_number, account_name, sort) VALUES (?, ?, ?, ?, ?, ?)')
    .run(inv.id, type, bank_name.trim(), account_number.trim(), account_name.trim(), sort);
  flash(req, 'success', 'Rekening ditambahkan.');
  res.redirect(`/panel/undangan/${inv.id}/amplop`);
});

router.put('/amplop/:id', (req, res) => {
  const row = ownedChild(req, res, 'gifts');
  if (!row) return;
  const { type, bank_name, account_number, account_name } = req.body;
  db.prepare('UPDATE gifts SET type = ?, bank_name = ?, account_number = ?, account_name = ? WHERE id = ?')
    .run(['bank', 'ewallet'].includes(type) ? type : 'bank', (bank_name || '').trim(), (account_number || '').trim(), (account_name || '').trim(), row.id);
  flash(req, 'success', 'Rekening diperbarui.');
  res.redirect(`/panel/undangan/${row._invitation_id}/amplop`);
});

router.delete('/amplop/:id', (req, res) => {
  const row = ownedChild(req, res, 'gifts');
  if (!row) return;
  db.prepare('DELETE FROM gifts WHERE id = ?').run(row.id);
  flash(req, 'success', 'Rekening dihapus.');
  res.redirect(`/panel/undangan/${row._invitation_id}/amplop`);
});

// ============ Tamu ============
router.get('/undangan/:id/tamu', (req, res) => {
  const inv = ownedInvitation(req, res);
  if (!inv) return;
  const guests = db.prepare('SELECT * FROM guests WHERE invitation_id = ? ORDER BY id DESC').all(inv.id);
  const base = `${req.protocol}://${req.get('host')}/u/${inv.slug}`;
  res.render('panel/guests', { title: 'Tamu & Spread Link', active: 'undangan', inv, guests, base, tab: 'tamu' });
});

router.post('/undangan/:id/tamu', (req, res) => {
  const inv = ownedInvitation(req, res);
  if (!inv) return;
  const { name, category, phone } = req.body;
  if (!name) {
    flash(req, 'error', 'Nama tamu wajib diisi.');
    return res.redirect(`/panel/undangan/${inv.id}/tamu`);
  }
  db.prepare('INSERT INTO guests (invitation_id, name, category, phone, token) VALUES (?, ?, ?, ?, ?)')
    .run(inv.id, name.trim(), (category || 'umum').trim(), (phone || '').trim(), randomToken(10));
  flash(req, 'success', 'Tamu ditambahkan.');
  res.redirect(`/panel/undangan/${inv.id}/tamu`);
});

router.post('/undangan/:id/tamu/impor', (req, res) => {
  const inv = ownedInvitation(req, res);
  if (!inv) return;
  const lines = String(req.body.names || '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) {
    flash(req, 'error', 'Isi minimal satu nama (satu nama per baris).');
    return res.redirect(`/panel/undangan/${inv.id}/tamu`);
  }
  const insert = db.prepare('INSERT INTO guests (invitation_id, name, category, phone, token) VALUES (?, ?, ?, ?, ?)');
  let n = 0;
  for (const line of lines.slice(0, 200)) {
    const [name, category, phone] = line.split('|').map((p) => (p || '').trim());
    if (!name) continue;
    insert.run(inv.id, name, category || 'umum', phone || '', randomToken(10));
    n++;
  }
  flash(req, 'success', `${n} tamu berhasil diimpor.`);
  res.redirect(`/panel/undangan/${inv.id}/tamu`);
});

router.put('/tamu/:id', (req, res) => {
  const row = ownedChild(req, res, 'guests');
  if (!row) return;
  const { name, category, phone } = req.body;
  if (!name) {
    flash(req, 'error', 'Nama tamu wajib diisi.');
    return res.redirect(`/panel/undangan/${row._invitation_id}/tamu`);
  }
  db.prepare('UPDATE guests SET name = ?, category = ?, phone = ? WHERE id = ?')
    .run(name.trim(), (category || 'umum').trim(), (phone || '').trim(), row.id);
  flash(req, 'success', 'Data tamu diperbarui.');
  res.redirect(`/panel/undangan/${row._invitation_id}/tamu`);
});

router.post('/tamu/:id/kirim', (req, res) => {
  const row = ownedChild(req, res, 'guests');
  if (!row) return;
  db.prepare('UPDATE guests SET is_sent = 1 - is_sent WHERE id = ?').run(row.id);
  flash(req, 'success', 'Status kirim diperbarui.');
  res.redirect(`/panel/undangan/${row._invitation_id}/tamu`);
});

router.delete('/tamu/:id', (req, res) => {
  const row = ownedChild(req, res, 'guests');
  if (!row) return;
  db.prepare('DELETE FROM guests WHERE id = ?').run(row.id);
  flash(req, 'success', 'Tamu dihapus.');
  res.redirect(`/panel/undangan/${row._invitation_id}/tamu`);
});

// ============ RSVP ============
router.get('/undangan/:id/rsvp', (req, res) => {
  const inv = ownedInvitation(req, res);
  if (!inv) return;
  const rsvps = db.prepare('SELECT r.*, g.name AS guest_name FROM rsvps r LEFT JOIN guests g ON g.id = r.guest_id WHERE r.invitation_id = ? ORDER BY r.id DESC').all(inv.id);
  const summary = { hadir: 0, tidak: 0, ragu: 0, orang: 0 };
  rsvps.forEach((r) => {
    summary[r.attendance]++;
    summary.orang += r.attendee_count;
  });
  res.render('panel/rsvps', { title: 'RSVP', active: 'undangan', inv, rsvps, summary, tab: 'rsvp' });
});

router.delete('/rsvp/:id', (req, res) => {
  const row = ownedChild(req, res, 'rsvps');
  if (!row) return;
  db.prepare('DELETE FROM rsvps WHERE id = ?').run(row.id);
  flash(req, 'success', 'Data RSVP dihapus.');
  res.redirect(`/panel/undangan/${row._invitation_id}/rsvp`);
});

// ============ Ucapan ============
router.get('/undangan/:id/ucapan', (req, res) => {
  const inv = ownedInvitation(req, res);
  if (!inv) return;
  const wishes = db.prepare('SELECT * FROM wishes WHERE invitation_id = ? ORDER BY id DESC').all(inv.id);
  res.render('panel/wishes', { title: 'Ucapan', active: 'undangan', inv, wishes, tab: 'ucapan' });
});

router.post('/ucapan/:id/tampil', (req, res) => {
  const row = ownedChild(req, res, 'wishes');
  if (!row) return;
  db.prepare('UPDATE wishes SET is_approved = 1 - is_approved WHERE id = ?').run(row.id);
  flash(req, 'success', 'Status ucapan diperbarui.');
  res.redirect(`/panel/undangan/${row._invitation_id}/ucapan`);
});

router.delete('/ucapan/:id', (req, res) => {
  const row = ownedChild(req, res, 'wishes');
  if (!row) return;
  db.prepare('DELETE FROM wishes WHERE id = ?').run(row.id);
  flash(req, 'success', 'Ucapan dihapus.');
  res.redirect(`/panel/undangan/${row._invitation_id}/ucapan`);
});

// ============ Pengaturan undangan (tema, slug, musik, terbitkan) ============
router.get('/undangan/:id/pengaturan', (req, res) => {
  const inv = ownedInvitation(req, res);
  if (!inv) return;
  const themes = db.prepare('SELECT * FROM themes WHERE is_active = 1 ORDER BY name').all();
  res.render('panel/settings', { title: 'Pengaturan Undangan', active: 'undangan', inv, themes, tab: 'pengaturan' });
});

router.post('/undangan/:id/pengaturan', (req, res) => {
  const inv = ownedInvitation(req, res);
  if (!inv) return;
  const { theme_id, music_url, slug, status } = req.body;

  let newSlug = inv.slug;
  if (slug && slug !== inv.slug) {
    newSlug = slugify(slug);
    if (!newSlug) {
      flash(req, 'error', 'Slug tidak valid.');
      return res.redirect(`/panel/undangan/${inv.id}/pengaturan`);
    }
    const taken = db.prepare('SELECT id FROM invitations WHERE slug = ? AND id != ?').get(newSlug, inv.id);
    if (taken) {
      flash(req, 'error', 'Slug sudah dipakai undangan lain.');
      return res.redirect(`/panel/undangan/${inv.id}/pengaturan`);
    }
  }

  const theme = theme_id ? db.prepare('SELECT id FROM themes WHERE id = ? AND is_active = 1').get(theme_id) : null;
  db.prepare(`UPDATE invitations SET theme_id = ?, music_url = ?, slug = ?, status = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(theme ? theme.id : null, (music_url || '').trim(), newSlug, status === 'published' ? 'published' : 'draft', inv.id);
  flash(req, 'success', 'Pengaturan tersimpan.');
  res.redirect(`/panel/undangan/${inv.id}/pengaturan`);
});

// ============ Profil ============
router.get('/profil', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);
  res.render('panel/profile', { title: 'Profil Saya', active: 'profil', user });
});

router.post('/profil', (req, res) => {
  const { name, phone } = req.body;
  if (!name) {
    flash(req, 'error', 'Nama wajib diisi.');
    return res.redirect('/panel/profil');
  }
  db.prepare('UPDATE users SET name = ?, phone = ? WHERE id = ?').run(name.trim(), (phone || '').trim(), req.session.user.id);
  req.session.user.name = name.trim();
  flash(req, 'success', 'Profil diperbarui.');
  res.redirect('/panel/profil');
});

router.post('/profil/sandi', (req, res) => {
  const { current_password, new_password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);
  if (!bcrypt.compareSync(String(current_password || ''), user.password)) {
    flash(req, 'error', 'Kata sandi saat ini salah.');
    return res.redirect('/panel/profil');
  }
  if (!new_password || new_password.length < 6) {
    flash(req, 'error', 'Kata sandi baru minimal 6 karakter.');
    return res.redirect('/panel/profil');
  }
  db.prepare('UPDATE users SET password = ? WHERE id = ?').run(bcrypt.hashSync(new_password, 10), user.id);
  flash(req, 'success', 'Kata sandi berhasil diganti.');
  res.redirect('/panel/profil');
});

module.exports = router;
