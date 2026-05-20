require('dotenv').config();
const express      = require('express');
const { Pool }     = require('pg');
const cors         = require('cors');
const nodemailer   = require('nodemailer');
const validator    = require('validator');
const { v4: uuid } = require('uuid');
const path         = require('path');

const PORT       = process.env.PORT || 3000;
const ADMIN_USER = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASSWORD || 'changeme';

// ── NEON POSTGRESQL ────────────────────────────────────────────────────────
// Neon requires SSL — works free forever
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

// Test connection on startup
pool.connect((err, client, release) => {
  if (err) {
    console.error('❌ Database connection failed:', err.message);
  } else {
    console.log('✅ Connected to Neon PostgreSQL');
    release();
  }
});

async function initDB() {
  try {
    await pool.query(`
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
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        updated_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    console.log('✅ Database table ready');
  } catch (err) {
    console.error('❌ Table creation failed:', err.message);
    process.exit(1);
  }
}

// ── EMAIL ──────────────────────────────────────────────────────────────────
let transporter = null;
if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
  transporter = nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port:   parseInt(process.env.SMTP_PORT) || 587,
    secure: false,
    auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
}

async function sendEmail(s) {
  if (!transporter || !process.env.NOTIFY_EMAIL) return;
  try {
    await transporter.sendMail({
      from:    `"Kaitra.ai" <${process.env.SMTP_USER}>`,
      to:      process.env.NOTIFY_EMAIL,
      subject: `New Early Access — ${s.name}`,
      html: `
        <div style="font-family:sans-serif;max-width:600px;background:#090d1a;
             color:#eef4ff;border-radius:12px;overflow:hidden;margin:0 auto">
          <div style="background:linear-gradient(135deg,#00c8ff,#0af0d8);padding:24px 32px">
            <h2 style="margin:0;color:#050810">New Early Access Request</h2>
            <p style="margin:4px 0 0;color:#050810;opacity:.75;font-size:.9rem">
              ${new Date().toUTCString()}
            </p>
          </div>
          <div style="padding:28px 32px">
            ${[
              ['Name',    s.name],
              ['Email',   s.email],
              ['Company', s.company   || '—'],
              ['Phone',   s.phone     || '—'],
              ['Role',    s.role      || '—'],
              ['Team',    s.team_size || '—'],
              ['Sectors', s.sectors   || '—'],
            ].map(([k,v]) => `
              <div style="display:flex;padding:10px 0;border-bottom:1px solid rgba(0,200,255,.08)">
                <span style="width:100px;color:#5a6a8a;font-size:.9rem">${k}</span>
                <span style="color:#eef4ff;font-weight:600">${v}</span>
              </div>
            `).join('')}
            <div style="margin-top:20px;background:rgba(0,200,255,.06);
                 padding:16px;border-radius:8px;border-left:3px solid #00c8ff">
              <p style="color:#5a6a8a;font-size:.8rem;margin-bottom:8px">MESSAGE</p>
              <p style="margin:0;line-height:1.6;color:#c8d8e8">${s.message}</p>
            </div>
          </div>
        </div>
      `
    });
    console.log('📧 Email sent for', s.email);
  } catch (e) {
    console.error('Email error:', e.message);
  }
}

// ── EXPRESS ────────────────────────────────────────────────────────────────
const app = express();

app.set('trust proxy', 1);
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname)));

// ── AUTH ───────────────────────────────────────────────────────────────────
function adminAuth(req, res, next) {
  const auth    = req.headers['authorization'] || '';
  const decoded = Buffer.from(auth.replace('Basic ', ''), 'base64').toString('utf8');
  const [u, p]  = decoded.split(':');
  if (u === ADMIN_USER && p === ADMIN_PASS) return next();
  res.setHeader('WWW-Authenticate', 'Basic realm="Kaitra Admin"');
  return res.status(401).json({ success: false, error: 'Unauthorized' });
}

// ══════════════════════════════════════════════════════════════════════════
//  PUBLIC ROUTES
// ══════════════════════════════════════════════════════════════════════════

// Health check
app.get('/api/health', async (req, res) => {
  try {
    const r = await pool.query('SELECT COUNT(*) c FROM submissions');
    res.json({
      status:      'ok',
      db:          'Neon PostgreSQL (free forever)',
      submissions: parseInt(r.rows[0].c),
      time:        new Date().toISOString()
    });
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
});

// Submit form
app.post('/api/submissions', async (req, res) => {
  try {
    const { name, email, company, phone, role, team_size, sectors, message } = req.body;

    // Validate
    const errors = {};
    if (!name    || name.trim().length < 2)    errors.name    = 'Name required';
    if (!email   || !validator.isEmail(email)) errors.email   = 'Valid email required';
    if (!message || message.trim().length < 5) errors.message = 'Message required';
    if (Object.keys(errors).length)
      return res.status(422).json({ success: false, errors });

    const id         = uuid();
    const sectorsStr = Array.isArray(sectors) ? sectors.join(', ') : (sectors || '');

    await pool.query(
      `INSERT INTO submissions
         (id,name,email,company,phone,role,team_size,sectors,message,ip,user_agent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        id,
        validator.escape(name.trim()),
        email.trim().toLowerCase(),
        company   ? validator.escape(company.trim())   : null,
        phone     ? phone.trim()                       : null,
        role      || null,
        team_size || null,
        sectorsStr || null,
        validator.escape(message.trim()),
        req.ip || 'unknown',
        req.headers['user-agent'] || 'unknown'
      ]
    );

    console.log(`✅ Saved: ${name} <${email}>`);
    sendEmail({ name, email, company, phone, role, team_size, sectors: sectorsStr, message });

    res.status(201).json({
      success: true,
      message: "Request received! We'll be in touch within 24 hours.",
      id
    });
  } catch (err) {
    console.error('❌ Submit error:', err.message);
    res.status(500).json({ success: false, error: 'Server error. Please try again.' });
  }
});

// ══════════════════════════════════════════════════════════════════════════
//  ADMIN ROUTES
// ══════════════════════════════════════════════════════════════════════════

// List submissions
app.get('/api/admin/submissions', adminAuth, async (req, res) => {
  try {
    const page   = Math.max(1, parseInt(req.query.page  || 1));
    const limit  = Math.min(100, parseInt(req.query.limit || 20));
    const offset = (page - 1) * limit;
    const search = (req.query.search || '').trim();
    const status = (req.query.status || '').trim();

    let where  = 'WHERE 1=1';
    let params = [];
    let idx    = 1;

    if (search) {
      where += ` AND (name ILIKE $${idx} OR email ILIKE $${idx}
                 OR COALESCE(company,'') ILIKE $${idx}
                 OR COALESCE(sectors,'') ILIKE $${idx})`;
      params.push(`%${search}%`);
      idx++;
    }
    if (status) {
      where += ` AND status = $${idx}`;
      params.push(status);
      idx++;
    }

    const total     = parseInt((await pool.query(`SELECT COUNT(*) c FROM submissions ${where}`, params)).rows[0].c);
    const rows      = (await pool.query(`SELECT * FROM submissions ${where} ORDER BY created_at DESC LIMIT $${idx} OFFSET $${idx+1}`, [...params, limit, offset])).rows;
    const byStatus  = (await pool.query(`SELECT status, COUNT(*) count FROM submissions GROUP BY status`)).rows;

    res.json({
      success: true,
      data:    rows,
      meta: {
        total,
        page,
        limit,
        pages:     Math.ceil(total / limit) || 1,
        by_status: byStatus
      }
    });
  } catch (err) {
    console.error('❌ Admin list error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get single submission
app.get('/api/admin/submissions/:id', adminAuth, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM submissions WHERE id=$1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ success: false, error: 'Not found' });
    res.json({ success: true, data: r.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Update status/notes
app.patch('/api/admin/submissions/:id', adminAuth, async (req, res) => {
  try {
    const { status, notes } = req.body;
    const allowed = ['new','contacted','approved','rejected'];
    if (status && !allowed.includes(status))
      return res.status(400).json({ success: false, error: 'Invalid status' });

    await pool.query(
      `UPDATE submissions
         SET status     = COALESCE($1, status),
             notes      = COALESCE($2, notes),
             updated_at = NOW()
       WHERE id = $3`,
      [status || null, notes !== undefined ? notes : null, req.params.id]
    );
    res.json({ success: true, message: 'Updated' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Delete
app.delete('/api/admin/submissions/:id', adminAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM submissions WHERE id=$1', [req.params.id]);
    res.json({ success: true, message: 'Deleted' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Export CSV
app.get('/api/admin/export', adminAuth, async (req, res) => {
  try {
    const rows = (await pool.query('SELECT * FROM submissions ORDER BY created_at DESC')).rows;
    const cols = ['id','name','email','company','phone','role','team_size','sectors','message','status','notes','ip','created_at'];
    const csv  = [
      cols.join(','),
      ...rows.map(r => cols.map(c => `"${String(r[c]||'').replace(/"/g,'""')}"`).join(','))
    ].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="kaitra_${Date.now()}.csv"`);
    res.send(csv);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Stats
app.get('/api/admin/stats', adminAuth, async (req, res) => {
  try {
    const total    = parseInt((await pool.query('SELECT COUNT(*) c FROM submissions')).rows[0].c);
    const h24      = parseInt((await pool.query(`SELECT COUNT(*) c FROM submissions WHERE created_at >= NOW() - INTERVAL '1 day'`)).rows[0].c);
    const d7       = parseInt((await pool.query(`SELECT COUNT(*) c FROM submissions WHERE created_at >= NOW() - INTERVAL '7 days'`)).rows[0].c);
    const byStatus = (await pool.query('SELECT status, COUNT(*) count FROM submissions GROUP BY status')).rows;
    const topSec   = (await pool.query(`
      SELECT sectors, COUNT(*) count FROM submissions
      WHERE sectors IS NOT NULL AND sectors != ''
      GROUP BY sectors ORDER BY count DESC LIMIT 5
    `)).rows;
    res.json({ success: true, data: { total, recent24h: h24, recent7d: d7, by_status: byStatus, top_sectors: topSec } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Serve admin panel
app.get('/admin', adminAuth, (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));

// Catch-all → index.html
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ── START ──────────────────────────────────────────────────────────────────
async function start() {
  await initDB();
  app.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════╗
║       KAITRA.AI — RUNNING                   ║
╠══════════════════════════════════════════════╣
║  🌐 Website → http://localhost:${PORT}           ║
║  🔒 Admin   → http://localhost:${PORT}/admin      ║
║  💾 DB      → Neon PostgreSQL (FREE FOREVER) ║
╚══════════════════════════════════════════════╝
    `);
  });
}

start();
process.on('SIGINT',  () => { pool.end(); process.exit(0); });
process.on('SIGTERM', () => { pool.end(); process.exit(0); });
