# Kaitra.ai — Full Stack Setup Guide

## Project Structure

```
kaitra-ai/
├── index.html        ← Frontend website (served by Express)
├── admin.html        ← Admin panel (protected by Basic Auth)
├── server.js         ← Express + SQLite backend
├── package.json      ← Node.js dependencies
├── .env.example      ← Copy to .env and fill in values
├── data/
│   └── kaitra.db     ← SQLite database (auto-created on first run)
└── README.md
```

---

## Quick Start

### 1. Install Node.js (v18+)
Download from https://nodejs.org

### 2. Install dependencies
```bash
npm install
```

### 3. Configure environment
```bash
cp .env.example .env
# Edit .env with your values
```

### 4. Start the server
```bash
# Production
npm start

# Development (auto-restart on file changes)
npm run dev
```

### 5. Open in browser
- **Website**    → http://localhost:3000
- **Admin Panel** → http://localhost:3000/admin
  - Default login: `admin` / `changeme`
  - ⚠️ Change these in your `.env` file!

---

## API Reference

### Public Endpoints

| Method | URL | Description |
|--------|-----|-------------|
| `POST` | `/api/submissions` | Submit early access form |
| `GET`  | `/api/health`      | Server health check |

**POST /api/submissions — Request Body:**
```json
{
  "name":      "Dr. Reena Mathur",
  "email":     "reena@medcore.in",
  "company":   "MedCore Hospital",
  "phone":     "+91 98765 43210",
  "role":      "Healthcare Professional",
  "team_size": "51 – 200",
  "sectors":   ["Health", "Research"],
  "message":   "We want to automate radiology workflows."
}
```

**Response (201 Created):**
```json
{
  "success": true,
  "message": "Your request has been received!",
  "id": "uuid-here"
}
```

---

### Admin Endpoints (Basic Auth required)

| Method   | URL                          | Description |
|----------|------------------------------|-------------|
| `GET`    | `/api/admin/submissions`     | List all (paginated, searchable) |
| `GET`    | `/api/admin/submissions/:id` | Get single submission |
| `PATCH`  | `/api/admin/submissions/:id` | Update status / notes |
| `DELETE` | `/api/admin/submissions/:id` | Delete submission |
| `GET`    | `/api/admin/export`          | Download all as CSV |
| `GET`    | `/api/admin/stats`           | Aggregated analytics |

**Query Parameters (GET /api/admin/submissions):**
```
?page=1&limit=20&search=reena&status=new
```

**PATCH Body:**
```json
{
  "status": "contacted",
  "notes":  "Called on 20 Mar — interested in Health + Research plan"
}
```
Status values: `new` | `contacted` | `approved` | `rejected`

---

## Admin Panel Features
- 📊 Live stat cards (Total, New, Contacted, Approved)
- 🔍 Real-time search across name, email, company, sectors
- 🏷️ Filter by status
- 👁️ View full submission details in a modal
- ✏️ Update status and add internal notes
- 🗑️ Delete submissions
- 📥 Export all data as CSV
- 📈 Analytics view with sector breakdown bars

---

## Email Notifications (Optional)
To receive an email for every new submission, add Gmail SMTP credentials to `.env`:

```env
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your@gmail.com
SMTP_PASS=your_16_char_app_password   # Google > Account > App Passwords
NOTIFY_EMAIL=team@kaitra.ai
```

> Use a **Gmail App Password**, not your regular password.
> Enable 2FA on your Google account first, then generate an App Password.

---

## Production Deployment

### Deploy on Railway / Render / Fly.io
1. Push this folder to a GitHub repo
2. Connect to Railway / Render
3. Set environment variables in the platform dashboard
4. Set start command: `node server.js`

### Deploy on VPS (Ubuntu)
```bash
# Install PM2 process manager
npm install -g pm2

# Start with PM2
pm2 start server.js --name kaitra-backend
pm2 save
pm2 startup

# Nginx reverse proxy (optional)
# Point your domain to localhost:3000
```

### Security Checklist for Production
- [ ] Change `ADMIN_USERNAME` and `ADMIN_PASSWORD` in `.env`
- [ ] Set `NODE_ENV=production`
- [ ] Set `ALLOWED_ORIGINS` to your actual domain
- [ ] Use HTTPS (via Nginx + Let's Encrypt, or platform TLS)
- [ ] Back up `./data/kaitra.db` regularly

---

## Database
Uses **SQLite** via `better-sqlite3` — no external database server needed.
Data is stored in `./data/kaitra.db` (auto-created).

To view the database manually:
```bash
# Install sqlite3 CLI
sudo apt install sqlite3    # Ubuntu
brew install sqlite3        # macOS

# Open the DB
sqlite3 data/kaitra.db

# Useful queries
.tables
SELECT * FROM submissions ORDER BY created_at DESC LIMIT 10;
SELECT status, COUNT(*) FROM submissions GROUP BY status;
.quit
```

---


