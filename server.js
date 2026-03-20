/**
 * ╔════════════════════════════════════════════════════╗
 * ║         KAITRA.AI — BACKEND SERVER                ║
 * ║     Express + PostgreSQL | Persistent Storage     ║
 * ╚════════════════════════════════════════════════════╝
 */

require('dotenv').config();
const express      = require('express');
const { Pool }     = require('pg');
const cors         = require('cors');
const helmet       = require('helmet');
const rateLimit    = require('express-rate-limit');
const nodemailer   = require('nodemailer');
const validator    = require('validator');
const { v4: uuid } = require('uuid');
const path         = require('path');

const PORT            = process.env.PORT || 3000;
const ADMIN_USER      = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASS      = process.env.ADMIN_PASSWORD || 'changeme';
const NOTIFY_EMAIL    = process.env.NOTIFY_EMAIL   || '';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*').split(',');

// ── POSTGRESQL ─────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
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
    console.error('❌ Database init error:', err.message);
    process.exit(1);
  }
}

// ── EMAIL ──────────────────────────────────────────────────────────────────
let transporter = null;
if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT) || 587,
    secure: false,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
}

async function sendNotificationEmail(s) {
  if (!transporter || !NOTIFY_EMAIL) return;
  try {
    await transporter.sendMail({
      from: `"Kaitra.ai" <${process.env.SMTP_USER}>`,
      to: NOTIFY_EMAIL,
      subject: `New Early Access Request — ${s.name}`,
      html: `<div style="font-family:sans-serif;padding:20px">
        <h2>New Submission</h2>
        <p><b>Name:</b> ${s.name}</p>
        <p><b>Email:</b> ${s.email}</p>
        <p><b>Company:</b> ${s.company||'—'}</p>
        <p><b>Role:</b> ${s.role||'—'}</p>
        <p><b>Sectors:</b> ${s.sectors||'—'}</p>
        <p><b>Message:</b> ${s.message}</p>
      </div>`
    });
    console.log('📧 Email sent for', s.email);
  } catch (err) { console.error('Email error:', err.message); }
}

// ── EXPRESS ────────────────────────────────────────────────────────────────
const app = express();
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: '*', methods: ['GET','POST','PATCH','DELETE'] }));
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname)));

const submissionLimiter = rateLimit({ windowMs: 15*60*1000, max: 10 });
const adminLimiter      = rateLimit({ windowMs:  5*60*1000, max: 60 });

function adminAuth(req, res, next) {
  const auth    = req.headers['authorization'] || '';
  const decoded = Buffer.from(auth.replace('Basic ',''), 'base64').toString('utf8');
  const [u, p]  = decoded.split(':');
  if (u === ADMIN_USER && p === ADMIN_PASS) return next();
  res.setHeader('WWW-Authenticate', 'Basic realm="Kaitra Admin"');
  res.status(401).json({ success: false, error: 'Unauthorized' });
}

// ── PUBLIC ─────────────────────────────────────────────────────────────────
app.post('/api/submissions', submissionLimiter, async (req, res) => {
  try {
    const { name, email, company, phone, role, team_size, sectors, message } = req.body;
    const errors = {};
    if (!name    || name.trim().length < 2)    errors.name    = 'Name required';
    if (!email   || !validator.isEmail(email)) errors.email   = 'Valid email required';
    if (!message || message.trim().length < 5) errors.message = 'Message required';
    if (Object.keys(errors).length)
      return res.status(422).json({ success: false, errors });

    const id = uuid();
    const sectorsStr = Array.isArray(sectors) ? sectors.join(', ') : (sectors || '');

    await pool.query(
      `INSERT INTO submissions (id,name,email,company,phone,role,team_size,sectors,message,ip,user_agent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [ id,
        validator.escape(name.trim()),
        email.trim().toLowerCase(),
        company   ? validator.escape(company.trim())   : null,
        phone     ? phone.trim()                       : null,
        role      ? validator.escape(role.trim())      : null,
        team_size ? validator.escape(team_size.trim()) : null,
        sectorsStr || null,
        validator.escape(message.trim()),
        req.ip || 'unknown',
        req.headers['user-agent'] || 'unknown'
      ]
    );
    console.log(`✅ Saved: ${name} <${email}>`);
    sendNotificationEmail({ name, email, company, phone, role, sectors: sectorsStr, message });
    res.status(201).json({ success: true, message: "Request received! We'll be in touch within 24 hours.", id });
  } catch (err) {
    console.error('Submit error:', err);
    res.status(500).json({ success: false, error: 'Server error. Please try again.' });
  }
});

app.get('/api/health', async (req, res) => {
  const r = await pool.query('SELECT COUNT(*) as total FROM submissions');
  res.json({ status: 'ok', submissions: parseInt(r.rows[0].total), time: new Date().toISOString() });
});

// ── ADMIN ──────────────────────────────────────────────────────────────────
app.get('/api/admin/submissions', adminLimiter, adminAuth, async (req, res) => {
  try {
    const page   = Math.max(1, parseInt(req.query.page  || 1));
    const limit  = Math.min(100, parseInt(req.query.limit || 20));
    const offset = (page-1)*limit;
    const search = req.query.search || '';
    const status = req.query.status || '';

    let where = 'WHERE 1=1';
    const params = [];
    let i = 1;
    if (search) { where += ` AND (name ILIKE $${i} OR email ILIKE $${i} OR company ILIKE $${i} OR sectors ILIKE $${i})`; params.push(`%${search}%`); i++; }
    if (status) { where += ` AND status=$${i}`;  params.push(status); i++; }

    const total   = parseInt((await pool.query(`SELECT COUNT(*) as c FROM submissions ${where}`, params)).rows[0].c);
    const rows    = (await pool.query(`SELECT * FROM submissions ${where} ORDER BY created_at DESC LIMIT $${i} OFFSET $${i+1}`, [...params, limit, offset])).rows;
    const byStatus = (await pool.query(`SELECT status, COUNT(*) as count FROM submissions GROUP BY status`)).rows;

    res.json({ success:true, data:rows, meta:{ total, page, limit, pages:Math.ceil(total/limit), by_status:byStatus } });
  } catch(err) { res.status(500).json({ success:false, error:'DB error' }); }
});

app.get('/api/admin/submissions/:id', adminLimiter, adminAuth, async (req, res) => {
  const r = await pool.query('SELECT * FROM submissions WHERE id=$1', [req.params.id]);
  if (!r.rows.length) return res.status(404).json({ success:false, error:'Not found' });
  res.json({ success:true, data:r.rows[0] });
});

app.patch('/api/admin/submissions/:id', adminLimiter, adminAuth, async (req, res) => {
  const { status, notes } = req.body;
  const allowed = ['new','contacted','approved','rejected'];
  if (status && !allowed.includes(status))
    return res.status(400).json({ success:false, error:'Invalid status' });
  await pool.query(
    `UPDATE submissions SET status=COALESCE($1,status), notes=COALESCE($2,notes), updated_at=NOW() WHERE id=$3`,
    [status||null, notes!==undefined?notes:null, req.params.id]
  );
  res.json({ success:true, message:'Updated' });
});

app.delete('/api/admin/submissions/:id', adminLimiter, adminAuth, async (req, res) => {
  await pool.query('DELETE FROM submissions WHERE id=$1', [req.params.id]);
  res.json({ success:true, message:'Deleted' });
});

app.get('/api/admin/export', adminLimiter, adminAuth, async (req, res) => {
  const rows = (await pool.query('SELECT * FROM submissions ORDER BY created_at DESC')).rows;
  const headers = ['id','name','email','company','phone','role','team_size','sectors','message','status','notes','ip','created_at'];
  const csv = [
    headers.join(','),
    ...rows.map(r => headers.map(h => `"${String(r[h]||'').replace(/"/g,'""')}"`).join(','))
  ].join('\n');
  res.setHeader('Content-Type','text/csv');
  res.setHeader('Content-Disposition',`attachment; filename="kaitra_${Date.now()}.csv"`);
  res.send(csv);
});

app.get('/api/admin/stats', adminLimiter, adminAuth, async (req, res) => {
  const total    = parseInt((await pool.query('SELECT COUNT(*) c FROM submissions')).rows[0].c);
  const h24      = parseInt((await pool.query(`SELECT COUNT(*) c FROM submissions WHERE created_at>=NOW()-INTERVAL '1 day'`)).rows[0].c);
  const d7       = parseInt((await pool.query(`SELECT COUNT(*) c FROM submissions WHERE created_at>=NOW()-INTERVAL '7 days'`)).rows[0].c);
  const byStatus = (await pool.query('SELECT status, COUNT(*) count FROM submissions GROUP BY status')).rows;
  const topSec   = (await pool.query(`SELECT sectors, COUNT(*) count FROM submissions WHERE sectors IS NOT NULL GROUP BY sectors ORDER BY count DESC LIMIT 5`)).rows;
  res.json({ success:true, data:{ total, recent24h:h24, recent7d:d7, by_status:byStatus, top_sectors:topSec } });
});

app.get('/admin', adminAuth, (req,res) => res.sendFile(path.join(__dirname,'admin.html')));
app.get('*', (req,res) => res.sendFile(path.join(__dirname,'index.html')));

// ── START ───────────────────────────────────────────────────────────────────
async function start() {
  await initDB();
  app.listen(PORT, () => {
    console.log(`
╔════════════════════════════════════════╗
║    KAITRA.AI BACKEND — RUNNING         ║
╠════════════════════════════════════════╣
║  Website  →  http://localhost:${PORT}     ║
║  Admin    →  http://localhost:${PORT}/admin║
║  DB       →  PostgreSQL (persistent)  ║
╚════════════════════════════════════════╝`);
  });
}

start();
process.on('SIGINT',  () => { pool.end(); process.exit(0); });
process.on('SIGTERM', () => { pool.end(); process.exit(0); });
