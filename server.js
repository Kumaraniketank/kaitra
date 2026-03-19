/**
 * ╔════════════════════════════════════════════════════╗
 * ║         KAITRA.AI — BACKEND SERVER                ║
 * ║  Express + SQLite | Submissions API + Admin Panel ║
 * ╚════════════════════════════════════════════════════╝
 */

require('dotenv').config();
const express      = require('express');
const Database     = require('better-sqlite3');
const cors         = require('cors');
const helmet       = require('helmet');
const rateLimit    = require('express-rate-limit');
const nodemailer   = require('nodemailer');
const validator    = require('validator');
const { v4: uuid } = require('uuid');
const path         = require('path');
const fs           = require('fs');

// ── CONFIG ─────────────────────────────────────────────────────────────────
const PORT           = process.env.PORT || 3000;
const DB_PATH        = process.env.DB_PATH || './data/kaitra.db';
const ADMIN_USER     = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASS     = process.env.ADMIN_PASSWORD || 'changeme';
const NOTIFY_EMAIL   = process.env.NOTIFY_EMAIL || '';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*').split(',');

// ── ENSURE DATA DIRECTORY ──────────────────────────────────────────────────
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

// ── DATABASE SETUP ─────────────────────────────────────────────────────────
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');  // faster writes

db.exec(`
  CREATE TABLE IF NOT EXISTS submissions (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    email       TEXT NOT NULL,
    company     TEXT,
    phone       TEXT,
    role        TEXT,
    team_size   TEXT,
    sectors     TEXT,
    message     TEXT NOT NULL,
    ip          TEXT,
    user_agent  TEXT,
    status      TEXT DEFAULT 'new',
    notes       TEXT DEFAULT '',
    created_at  DATETIME DEFAULT (datetime('now')),
    updated_at  DATETIME DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_email      ON submissions(email);
  CREATE INDEX IF NOT EXISTS idx_status     ON submissions(status);
  CREATE INDEX IF NOT EXISTS idx_created_at ON submissions(created_at);
`);

// ── PREPARED STATEMENTS ────────────────────────────────────────────────────
const stmtInsert = db.prepare(`
  INSERT INTO submissions (id, name, email, company, phone, role, team_size, sectors, message, ip, user_agent)
  VALUES (@id, @name, @email, @company, @phone, @role, @team_size, @sectors, @message, @ip, @user_agent)
`);

const stmtAll = db.prepare(`
  SELECT * FROM submissions ORDER BY created_at DESC LIMIT ? OFFSET ?
`);

const stmtCount = db.prepare(`SELECT COUNT(*) as total FROM submissions`);

const stmtCountByStatus = db.prepare(`
  SELECT status, COUNT(*) as count FROM submissions GROUP BY status
`);

const stmtFindById = db.prepare(`SELECT * FROM submissions WHERE id = ?`);

const stmtUpdateStatus = db.prepare(`
  UPDATE submissions SET status = ?, notes = ?, updated_at = datetime('now') WHERE id = ?
`);

const stmtDelete = db.prepare(`DELETE FROM submissions WHERE id = ?`);

const stmtSearch = db.prepare(`
  SELECT * FROM submissions
  WHERE name LIKE ? OR email LIKE ? OR company LIKE ? OR sectors LIKE ?
  ORDER BY created_at DESC LIMIT 50
`);

const stmtExportAll = db.prepare(`SELECT * FROM submissions ORDER BY created_at DESC`);

// ── EMAIL TRANSPORTER ──────────────────────────────────────────────────────
let transporter = null;
if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT) || 587,
    secure: false,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
}

async function sendNotificationEmail(submission) {
  if (!transporter || !NOTIFY_EMAIL) return;
  try {
    await transporter.sendMail({
      from: `"Kaitra.ai" <${process.env.SMTP_USER}>`,
      to: NOTIFY_EMAIL,
      subject: `🚀 New Early Access Request — ${submission.name}`,
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#090d1a;color:#eef4ff;border-radius:12px;overflow:hidden;">
          <div style="background:linear-gradient(135deg,#00c8ff,#0af0d8);padding:24px 32px;">
            <h2 style="margin:0;color:#050810;font-size:1.4rem;">New Early Access Request</h2>
            <p style="margin:4px 0 0;color:#050810;opacity:.75;font-size:.9rem;">Kaitra.ai — ${new Date().toUTCString()}</p>
          </div>
          <div style="padding:28px 32px;">
            <table style="width:100%;border-collapse:collapse;font-size:.95rem;">
              ${[
                ['Name',    submission.name],
                ['Email',   submission.email],
                ['Company', submission.company || '—'],
                ['Phone',   submission.phone   || '—'],
                ['Role',    submission.role    || '—'],
                ['Team',    submission.team_size || '—'],
                ['Sectors', submission.sectors  || '—'],
              ].map(([k,v]) => `
                <tr>
                  <td style="padding:10px 0;color:#5a6a8a;width:110px;vertical-align:top">${k}</td>
                  <td style="padding:10px 0;color:#eef4ff;font-weight:600">${v}</td>
                </tr>
              `).join('')}
            </table>
            <hr style="border:none;border-top:1px solid rgba(0,200,255,.15);margin:20px 0"/>
            <p style="color:#5a6a8a;margin-bottom:8px;font-size:.85rem;">MESSAGE</p>
            <p style="background:rgba(0,200,255,.06);padding:16px;border-radius:8px;border-left:3px solid #00c8ff;margin:0;line-height:1.6;">
              ${submission.message}
            </p>
            <p style="margin-top:24px;font-size:.8rem;color:#5a6a8a;">
              ID: ${submission.id} &nbsp;|&nbsp; IP: ${submission.ip}
            </p>
          </div>
        </div>
      `
    });
    console.log(`📧 Notification email sent for ${submission.email}`);
  } catch (err) {
    console.error('Email error:', err.message);
  }
}

// ── EXPRESS APP ────────────────────────────────────────────────────────────
const app = express();

// Security headers
app.use(helmet({ contentSecurityPolicy: false }));

// CORS
app.use(cors({
  origin: ALLOWED_ORIGINS.includes('*') ? '*' : ALLOWED_ORIGINS,
  methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true }));

// Serve static files (your website)
app.use(express.static(path.join(__dirname)));

// ── RATE LIMITING ──────────────────────────────────────────────────────────
const submissionLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 5,
  message: { success: false, error: 'Too many requests. Please try again later.' }
});

const adminLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,  // 5 min
  max: 30,
  message: { success: false, error: 'Too many admin requests.' }
});

// ── BASIC AUTH MIDDLEWARE (for admin routes) ───────────────────────────────
function adminAuth(req, res, next) {
  const authHeader = req.headers['authorization'] || '';
  const base64     = authHeader.replace('Basic ', '');
  const decoded    = Buffer.from(base64, 'base64').toString('utf8');
  const [user, pass] = decoded.split(':');
  if (user === ADMIN_USER && pass === ADMIN_PASS) return next();
  res.setHeader('WWW-Authenticate', 'Basic realm="Kaitra Admin"');
  res.status(401).json({ success: false, error: 'Unauthorized' });
}

// ══════════════════════════════════════════════════════════════════════════
//  PUBLIC API
// ══════════════════════════════════════════════════════════════════════════

/**
 * POST /api/submissions
 * Save a new early-access form submission
 */
app.post('/api/submissions', submissionLimiter, (req, res) => {
  try {
    const { name, email, company, phone, role, team_size, sectors, message } = req.body;

    // ── Validation ──────────────────────────────────────────────────────
    const errors = {};

    if (!name || name.trim().length < 2)
      errors.name = 'Name must be at least 2 characters.';

    if (!email || !validator.isEmail(email))
      errors.email = 'A valid email address is required.';

    if (!message || message.trim().length < 10)
      errors.message = 'Message must be at least 10 characters.';

    if (phone && !validator.isMobilePhone(phone.replace(/\s/g,''), 'any'))
      errors.phone = 'Enter a valid phone number or leave it blank.';

    if (Object.keys(errors).length > 0)
      return res.status(422).json({ success: false, errors });

    // ── Sanitize ────────────────────────────────────────────────────────
    const submission = {
      id:         uuid(),
      name:       validator.escape(name.trim()),
      email:      email.trim().toLowerCase(),
      company:    company   ? validator.escape(company.trim())   : null,
      phone:      phone     ? phone.trim()                       : null,
      role:       role      ? validator.escape(role.trim())      : null,
      team_size:  team_size ? validator.escape(team_size.trim()) : null,
      sectors:    Array.isArray(sectors) ? sectors.join(', ')    : (sectors || null),
      message:    validator.escape(message.trim()),
      ip:         req.ip || req.connection?.remoteAddress || 'unknown',
      user_agent: req.headers['user-agent'] || 'unknown'
    };

    // ── Insert ──────────────────────────────────────────────────────────
    stmtInsert.run(submission);
    console.log(`✅ New submission: ${submission.name} <${submission.email}>`);

    // Send email notification (async, non-blocking)
    sendNotificationEmail(submission);

    return res.status(201).json({
      success: true,
      message: 'Your request has been received! We\'ll be in touch within 24 hours.',
      id: submission.id
    });

  } catch (err) {
    console.error('Submission error:', err);
    return res.status(500).json({ success: false, error: 'Server error. Please try again.' });
  }
});

// ── Health Check ────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  const { total } = stmtCount.get();
  res.json({ status: 'ok', submissions: total, timestamp: new Date().toISOString() });
});

// ══════════════════════════════════════════════════════════════════════════
//  ADMIN API  (protected by Basic Auth)
// ══════════════════════════════════════════════════════════════════════════

/**
 * GET /api/admin/submissions?page=1&limit=20&search=query
 */
app.get('/api/admin/submissions', adminLimiter, adminAuth, (req, res) => {
  const page   = Math.max(1, parseInt(req.query.page  || 1));
  const limit  = Math.min(100, parseInt(req.query.limit || 20));
  const offset = (page - 1) * limit;
  const search = req.query.search || '';

  let rows;
  if (search) {
    const q = `%${search}%`;
    rows = stmtSearch.all(q, q, q, q);
  } else {
    rows = stmtAll.all(limit, offset);
  }

  const { total } = stmtCount.get();
  const byStatus  = stmtCountByStatus.all();

  res.json({
    success: true,
    data: rows,
    meta: {
      total,
      page,
      limit,
      pages: Math.ceil(total / limit),
      by_status: byStatus
    }
  });
});

/**
 * GET /api/admin/submissions/:id
 */
app.get('/api/admin/submissions/:id', adminLimiter, adminAuth, (req, res) => {
  const row = stmtFindById.get(req.params.id);
  if (!row) return res.status(404).json({ success: false, error: 'Not found' });
  res.json({ success: true, data: row });
});

/**
 * PATCH /api/admin/submissions/:id
 * Update status and notes
 * Body: { status: 'contacted' | 'approved' | 'rejected' | 'new', notes: '...' }
 */
app.patch('/api/admin/submissions/:id', adminLimiter, adminAuth, (req, res) => {
  const { status, notes } = req.body;
  const allowed = ['new', 'contacted', 'approved', 'rejected'];
  if (status && !allowed.includes(status))
    return res.status(400).json({ success: false, error: `Status must be one of: ${allowed.join(', ')}` });

  const existing = stmtFindById.get(req.params.id);
  if (!existing) return res.status(404).json({ success: false, error: 'Not found' });

  stmtUpdateStatus.run(
    status || existing.status,
    notes !== undefined ? notes : existing.notes,
    req.params.id
  );
  res.json({ success: true, message: 'Updated successfully' });
});

/**
 * DELETE /api/admin/submissions/:id
 */
app.delete('/api/admin/submissions/:id', adminLimiter, adminAuth, (req, res) => {
  const existing = stmtFindById.get(req.params.id);
  if (!existing) return res.status(404).json({ success: false, error: 'Not found' });
  stmtDelete.run(req.params.id);
  res.json({ success: true, message: 'Deleted successfully' });
});

/**
 * GET /api/admin/export
 * Download all submissions as CSV
 */
app.get('/api/admin/export', adminLimiter, adminAuth, (req, res) => {
  const rows = stmtExportAll.all();
  const headers = ['id','name','email','company','phone','role','team_size','sectors','message','status','notes','ip','created_at'];
  const csv = [
    headers.join(','),
    ...rows.map(r =>
      headers.map(h => {
        const v = r[h] == null ? '' : String(r[h]);
        return `"${v.replace(/"/g, '""')}"`;
      }).join(',')
    )
  ].join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="kaitra_submissions_${Date.now()}.csv"`);
  res.send(csv);
});

/**
 * GET /api/admin/stats
 */
app.get('/api/admin/stats', adminLimiter, adminAuth, (req, res) => {
  const total     = stmtCount.get().total;
  const byStatus  = stmtCountByStatus.all();
  const recent7d  = db.prepare(`
    SELECT COUNT(*) as count FROM submissions
    WHERE created_at >= datetime('now', '-7 days')
  `).get().count;
  const recent24h = db.prepare(`
    SELECT COUNT(*) as count FROM submissions
    WHERE created_at >= datetime('now', '-1 day')
  `).get().count;
  const topSectors = db.prepare(`
    SELECT sectors, COUNT(*) as count FROM submissions
    WHERE sectors IS NOT NULL GROUP BY sectors ORDER BY count DESC LIMIT 5
  `).all();

  res.json({ success: true, data: { total, recent7d, recent24h, by_status: byStatus, top_sectors: topSectors } });
});

// ── Serve admin panel HTML ─────────────────────────────────────────────────
app.get('/admin', adminAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

// ── Catch-all → serve index.html (SPA fallback) ────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── START ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════╗
║      KAITRA.AI BACKEND  — RUNNING         ║
╠═══════════════════════════════════════════╣
║  🌐 Website  →  http://localhost:${PORT}      ║
║  🔒 Admin    →  http://localhost:${PORT}/admin ║
║  💾 Database →  ${DB_PATH.padEnd(27)}║
╚═══════════════════════════════════════════╝
  `);
});

// Graceful shutdown
process.on('SIGINT',  () => { db.close(); process.exit(0); });
process.on('SIGTERM', () => { db.close(); process.exit(0); });
