const router = require('express').Router();
const { db } = require('../app/db');

function invitationBySlug(slug) {
  return db
    .prepare(
      `SELECT i.*, t.name AS theme_name, t.colors AS theme_colors
       FROM invitations i LEFT JOIN themes t ON t.id = i.theme_id
       WHERE i.slug = ?`
    )
    .get(slug);
}

router.get('/', (req, res) => {
  const themes = db.prepare('SELECT * FROM themes WHERE is_active = 1 ORDER BY id').all();
  const stats = {
    invitations: db.prepare("SELECT COUNT(*) c FROM invitations WHERE status = 'published'").get().c,
    guests: db.prepare('SELECT COUNT(*) c FROM guests').get().c,
    wishes: db.prepare('SELECT COUNT(*) c FROM wishes').get().c,
  };
  res.render('public/landing', { title: res.locals.site.site_name || 'UndanganKu', themes, stats });
});

router.get('/tema', (req, res) => {
  const themes = db.prepare('SELECT * FROM themes WHERE is_active = 1 ORDER BY id').all();
  res.render('public/themes', { title: 'Pilihan Tema', themes });
});

router.get('/u/:slug', (req, res) => {
  const inv = invitationBySlug(req.params.slug);
  if (!inv) return res.status(404).render('errors/404', { title: 'Undangan tidak ditemukan' });

  const user = req.session.user || null;
  const isOwner = !!user && (user.id === inv.user_id || user.role === 'admin');
  if (inv.status !== 'published' && !isOwner) {
    return res.status(404).render('errors/404', { title: 'Undangan tidak ditemukan' });
  }

  const events = db.prepare('SELECT * FROM events WHERE invitation_id = ? ORDER BY date, start_time').all(inv.id);
  const stories = db.prepare('SELECT * FROM stories WHERE invitation_id = ? ORDER BY sort, id').all(inv.id);
  const gallery = db.prepare('SELECT * FROM galleries WHERE invitation_id = ? ORDER BY sort, id').all(inv.id);
  const gifts = db.prepare("SELECT * FROM gifts WHERE invitation_id = ? AND type IN ('bank','ewallet') ORDER BY sort, id").all(inv.id);
  const rsvpCount = { hadir: 0, tidak: 0, ragu: 0, total: 0 };
  db.prepare('SELECT attendance, COUNT(*) c FROM rsvps WHERE invitation_id = ? GROUP BY attendance').all(inv.id).forEach((r) => {
    rsvpCount[r.attendance] = r.c;
    rsvpCount.total += r.c;
  });

  const guest = req.query.g
    ? db.prepare('SELECT * FROM guests WHERE token = ? AND invitation_id = ?').get(String(req.query.g), inv.id)
    : null;

  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const perPage = 6;
  const wishCount = db.prepare('SELECT COUNT(*) c FROM wishes WHERE invitation_id = ? AND is_approved = 1').get(inv.id).c;
  const wishes = db
    .prepare('SELECT * FROM wishes WHERE invitation_id = ? AND is_approved = 1 ORDER BY id DESC LIMIT ? OFFSET ?')
    .all(inv.id, perPage, (page - 1) * perPage);

  const firstEvent = events[0] || null;
  const couple = `${inv.groom_nickname || 'Mempelai'} & ${inv.bride_nickname || 'Mempelai'}`;

  res.render('public/invitation', {
    title: `${couple} — Undangan Pernikahan`,
    inv, events, stories, gallery, gifts, rsvpCount, guest, wishes, wishCount, page, perPage,
    wishPages: Math.ceil(wishCount / perPage),
    isDraftPreview: inv.status !== 'published',
    targetDate: firstEvent ? `${firstEvent.date}T${firstEvent.start_time || '00:00'}:00` : null,
  });
});

router.post('/u/:slug/rsvp', (req, res) => {
  const inv = invitationBySlug(req.params.slug);
  if (!inv || inv.status !== 'published') return res.status(404).render('errors/404', { title: 'Undangan tidak ditemukan' });

  const { name, attendance } = req.body;
  const attendee_count = Math.min(10, Math.max(1, parseInt(req.body.attendee_count, 10) || 1));

  if (!name || !['hadir', 'tidak', 'ragu'].includes(attendance)) {
    return res.redirect(`/u/${inv.slug}#rsvp`);
  }

  let guestId = null;
  if (req.body.g) {
    const guest = db.prepare('SELECT id FROM guests WHERE token = ? AND invitation_id = ?').get(String(req.body.g), inv.id);
    if (guest) guestId = guest.id;
  }

  db.prepare('INSERT INTO rsvps (invitation_id, guest_id, name, attendance, attendee_count) VALUES (?, ?, ?, ?, ?)').run(
    inv.id, guestId, name.trim().slice(0, 100), attendance, attendance === 'tidak' ? 0 : attendee_count
  );
  res.redirect(`/u/${inv.slug}?g=${req.body.g || ''}#rsvp`);
});

router.post('/u/:slug/wishes', (req, res) => {
  const inv = invitationBySlug(req.params.slug);
  if (!inv || inv.status !== 'published') return res.status(404).render('errors/404', { title: 'Undangan tidak ditemukan' });

  const { name, message } = req.body;
  if (!name || !message || !message.trim()) return res.redirect(`/u/${inv.slug}#ucapan`);

  db.prepare('INSERT INTO wishes (invitation_id, name, message, is_approved) VALUES (?, ?, ?, 1)').run(
    inv.id, name.trim().slice(0, 100), message.trim().slice(0, 500)
  );
  res.redirect(`/u/${inv.slug}#ucapan`);
});

module.exports = router;
