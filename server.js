'use strict';
const express = require('express');
const session = require('express-session');
const bcrypt  = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const fs   = require('fs');
const path = require('path');

// ── Config ─────────────────────────────────────────────────────────────────────
const PORT        = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'vem-secret-change-me-in-production';
const DATA_DIR    = process.env.DATA_DIR || path.join(__dirname, 'data');
const SUBS_DIR    = path.join(DATA_DIR, 'submissions');
const USERS_FILE  = path.join(DATA_DIR, 'users.json');

// ── Init filesystem ─────────────────────────────────────────────────────────────
[DATA_DIR, SUBS_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });
if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, '[]');

// ── Helpers ─────────────────────────────────────────────────────────────────────
function readUsers()  { try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch { return []; } }
function writeUsers(u){ fs.writeFileSync(USERS_FILE, JSON.stringify(u, null, 2)); }
function readSubs()   {
  return fs.readdirSync(SUBS_DIR).filter(f => f.endsWith('.json')).map(f => {
    try { return JSON.parse(fs.readFileSync(path.join(SUBS_DIR, f), 'utf8')); } catch { return null; }
  }).filter(Boolean).sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt));
}
function readSub(id)  { try { return JSON.parse(fs.readFileSync(path.join(SUBS_DIR, `${id}.json`), 'utf8')); } catch { return null; } }
function writeSub(sub){ fs.writeFileSync(path.join(SUBS_DIR, `${sub.id}.json`), JSON.stringify(sub, null, 2)); }

// ── Area data (shared with client) ─────────────────────────────────────────────
const AREA_LABELS = { shadowAI:'Shadow AI', chatbot:'Chatbot & RAG', promptInj:'Prompt Injection', agents:'Agenti AI', euAiAct:'EU AI Act', continuity:'Continuità' };
const AREA_COLORS = { shadowAI:'#7C3AED', chatbot:'#0A84D6', promptInj:'#EF4444', agents:'#F59E0B', euAiAct:'#059669', continuity:'#0EA5E9' };
const RATING_ORDER = ['CRITICO','ALTO','MEDIO','BASSO'];

function ratingBadge(r) {
  const colors = { CRITICO:'#EF4444', ALTO:'#F59E0B', MEDIO:'#3B82F6', BASSO:'#6B7280' };
  return `<span style="background:${colors[r]||'#ccc'};color:#fff;font-size:10px;font-weight:700;padding:2px 8px;border-radius:4px">${r||'?'}</span>`;
}
function statusBadge(s) {
  const map = { pending:['#FEF3C7','#92400E','In attesa'], reviewed:['#DBEAFE','#1E40AF','In review'], completed:['#D1FAE5','#065F46','Completato'] };
  const [bg,tc,lbl] = map[s] || ['#F1F5F9','#475569','—'];
  return `<span style="background:${bg};color:${tc};font-size:10px;font-weight:700;padding:2px 8px;border-radius:4px">${lbl}</span>`;
}

// ── Express setup ───────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 8 * 60 * 60 * 1000 } // 8h
}));

// ── Auth middleware ─────────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (req.session && req.session.userId) return next();
  res.redirect('/vem/login');
}

// ══════════════════════════════════════════════════════════════════════════════
// CLIENT ROUTES
// ══════════════════════════════════════════════════════════════════════════════

// Client page
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'client.html')));

// Submit questionnaire
app.post('/submit', (req, res) => {
  const data = req.body;
  if (!data || !data.company) return res.status(400).json({ error: 'Dati mancanti' });
  const sub = {
    id: uuidv4(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: 'pending',
    company: data.company || {},
    assets:  data.assets  || [],
    answers: data.answers || {},
    notes:   data.notes   || {},
    files:   data.files   || {},
    vemNotes: {},
    findings: [],
    reviewedBy: null,
    reviewedAt: null
  };
  writeSub(sub);
  res.json({ ok: true, id: sub.id });
});

// ══════════════════════════════════════════════════════════════════════════════
// SETUP ROUTE (first-time user creation)
// ══════════════════════════════════════════════════════════════════════════════
app.get('/vem/setup', (req, res) => {
  const users = readUsers();
  if (users.length > 0) return res.redirect('/vem/login');
  res.send(pageSetup());
});

app.post('/vem/setup', async (req, res) => {
  const users = readUsers();
  if (users.length > 0) return res.redirect('/vem/login');
  const { username, email, password } = req.body;
  if (!username || !password) return res.send(pageSetup('Compila tutti i campi'));
  const hash = await bcrypt.hash(password, 10);
  users.push({ id: uuidv4(), username, email: email||'', passwordHash: hash, createdAt: new Date().toISOString() });
  writeUsers(users);
  res.redirect('/vem/login?setup=ok');
});

// ══════════════════════════════════════════════════════════════════════════════
// VEM AUTH
// ══════════════════════════════════════════════════════════════════════════════
app.get('/vem/login', (req, res) => {
  const users = readUsers();
  if (users.length === 0) return res.redirect('/vem/setup');
  res.send(pageLogin(req.query.error, req.query.setup));
});

app.post('/vem/login', async (req, res) => {
  const { username, password } = req.body;
  const users = readUsers();
  const user = users.find(u => u.username === username);
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    return res.send(pageLogin('Username o password errati'));
  }
  req.session.userId   = user.id;
  req.session.username = user.username;
  res.redirect('/vem');
});

app.get('/vem/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/vem/login'));
});

// ── User management ─────────────────────────────────────────────────────────────
app.get('/vem/users', requireAuth, (req, res) => {
  res.send(pageUsers(req.session.username, readUsers()));
});

app.post('/vem/users', requireAuth, async (req, res) => {
  const users = readUsers();
  const { username, email, password } = req.body;
  if (!username || !password) return res.redirect('/vem/users?err=fields');
  if (users.find(u => u.username === username)) return res.redirect('/vem/users?err=exists');
  const hash = await bcrypt.hash(password, 10);
  users.push({ id: uuidv4(), username, email: email||'', passwordHash: hash, createdAt: new Date().toISOString() });
  writeUsers(users);
  res.redirect('/vem/users?ok=1');
});

app.post('/vem/users/delete', requireAuth, (req, res) => {
  const { id } = req.body;
  const users = readUsers().filter(u => u.id !== id);
  if (users.length === 0) return res.redirect('/vem/users?err=last');
  writeUsers(users);
  res.redirect('/vem/users?ok=1');
});

// ══════════════════════════════════════════════════════════════════════════════
// VEM DASHBOARD
// ══════════════════════════════════════════════════════════════════════════════
app.get('/vem', requireAuth, (req, res) => {
  const subs = readSubs();
  res.send(pageDashboard(req.session.username, subs));
});

// ══════════════════════════════════════════════════════════════════════════════
// VEM SUBMISSION DETAIL
// ══════════════════════════════════════════════════════════════════════════════
app.get('/vem/submission/:id', requireAuth, (req, res) => {
  const sub = readSub(req.params.id);
  if (!sub) return res.status(404).send('<h2>Submission non trovata</h2>');
  res.send(pageSubmission(req.session.username, sub));
});

// Save VEM notes/findings/status
app.post('/vem/submission/:id/save', requireAuth, (req, res) => {
  const sub = readSub(req.params.id);
  if (!sub) return res.status(404).json({ error: 'Not found' });
  const { vemNotes, findings, status } = req.body;
  sub.vemNotes    = vemNotes  || sub.vemNotes;
  sub.findings    = findings  || sub.findings;
  sub.status      = status    || sub.status;
  sub.reviewedBy  = req.session.username;
  sub.reviewedAt  = new Date().toISOString();
  sub.updatedAt   = new Date().toISOString();
  writeSub(sub);
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════════════════════
// HEALTH
// ══════════════════════════════════════════════════════════════════════════════
app.get('/api/health', (req,res) => res.json({ ok:true, ts: new Date().toISOString() }));

// ══════════════════════════════════════════════════════════════════════════════
// HTML TEMPLATES
// ══════════════════════════════════════════════════════════════════════════════

const HDR_LOGO = `<div style="display:flex;align-items:center;gap:12px"><img src="/VEM_RGB-NEGATIVO.png" height="32" alt="VEM" style="flex-shrink:0"><div style="font-family:'Syne',Arial,sans-serif;font-size:9px;font-weight:700;letter-spacing:.2em;color:rgba(255,255,255,.5);text-transform:uppercase;line-height:1">DRIVING DIGITAL</div></div>`;

const CSS_BASE = `
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Syne:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
/* ── VEM Brand 2025 ─────────────────────────────────────────────── */
:root{
  --navy:#0d2645;--navy2:#0f1f3c;--navy3:#162b52;
  --blue:#2563eb;--bluel:#60a5fa;--bluebg:#eff6ff;
  --teal:#00c9b0;--pink:#e8196b;--orange:#f5851f;--purple:#7b2af7;
  --green:#059669;--red:#ef4444;--slate:#64748b;--slatel:#94a3b8;
  --bg:#f4f7fa;--white:#fff;--text:#1e293b;--border:#e2e8f0;
  --galaxy:radial-gradient(ellipse at 15% 60%,rgba(232,25,107,.35) 0%,transparent 55%),
           radial-gradient(ellipse at 55% 10%,rgba(0,201,176,.28) 0%,transparent 50%),
           radial-gradient(ellipse at 85% 70%,rgba(245,133,31,.28) 0%,transparent 52%),
           radial-gradient(ellipse at 40% 80%,rgba(123,42,247,.22) 0%,transparent 48%),
           #0d2645;
}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Syne','Segoe UI',Arial,sans-serif;background:var(--bg);color:var(--text)}
.hdr{background:var(--galaxy);color:#fff;padding:11px 24px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:100;box-shadow:0 2px 16px rgba(0,0,0,.4)}
.hdr-logo{display:flex;align-items:center;gap:14px}
.hdr-divider{width:1px;height:30px;background:rgba(255,255,255,.15)}
.hdr-sub{font-family:'Syne',Arial,sans-serif;font-size:12px;color:rgba(255,255,255,.6)}
.hdr-nav{display:flex;align-items:center}
.hdr-nav a{color:rgba(255,255,255,.65);text-decoration:none;font-size:12px;margin-left:16px;font-weight:500;transition:color .15s}
.hdr-nav a:hover{color:#fff}
.hdr-user{font-size:12px;color:rgba(255,255,255,.55)}
.app{max-width:1100px;margin:0 auto;padding:24px 16px 60px}
.card{background:#fff;border:1px solid var(--border);border-radius:12px;padding:20px 22px;margin-bottom:16px;
  clip-path:polygon(0 0,100% 0,100% calc(100% - 14px),calc(100% - 14px) 100%,0 100%)}
.card-title{font-family:'Syne',Arial,sans-serif;font-size:18px;font-weight:700;letter-spacing:.02em;color:var(--navy);margin-bottom:4px}
.card-sub{font-size:13px;color:var(--slate);margin-bottom:14px}
.btn{display:inline-flex;align-items:center;gap:6px;padding:8px 16px;border-radius:7px;border:none;font-family:'Syne',Arial,sans-serif;font-size:13px;font-weight:600;cursor:pointer;text-decoration:none;transition:all .15s}
.btn-primary{background:var(--navy);color:#fff}.btn-primary:hover{background:#0f3060;box-shadow:0 0 0 3px rgba(0,201,176,.2)}
.btn-secondary{background:#fff;border:1.5px solid var(--border);color:var(--text)}.btn-secondary:hover{border-color:var(--navy);background:var(--bg)}
.btn-green{background:var(--green);color:#fff}.btn-danger{background:var(--red);color:#fff}
.btn-sm{padding:5px 11px;font-size:12px}
table{width:100%;border-collapse:collapse;font-size:13px}
th{background:var(--navy);color:#fff;padding:10px 12px;text-align:left;font-family:'Syne',Arial,sans-serif;font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase}
td{padding:10px 12px;border-bottom:1px solid var(--border)}
tr:hover td{background:#f8fafc}
.callout{background:#f0fdfa;border-left:3px solid var(--teal);padding:10px 14px;border-radius:0 6px 6px 0;font-size:13px;margin-bottom:14px}
.callout.warn{background:#fff7e6;border-color:var(--orange)}
.callout.red{background:#fee2e2;border-color:var(--red)}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:12px;margin-bottom:22px}
.stat{background:#fff;border:1px solid var(--border);border-radius:9px;padding:14px 16px;text-align:center}
.stat-n{font-family:'Syne',Arial,sans-serif;font-size:30px;font-weight:800;color:var(--navy)}.stat-l{font-size:11px;color:var(--slate);margin-top:2px;font-weight:500}
.stat.c{border-top:3px solid var(--red)}.stat.a{border-top:3px solid var(--orange)}.stat.m{border-top:3px solid var(--teal)}
input,select,textarea{width:100%;padding:8px 10px;border:1.5px solid var(--border);border-radius:6px;font-size:13px;font-family:inherit;background:#fff}
input:focus,select:focus,textarea:focus{outline:none;border-color:var(--teal)}
label{font-size:12px;font-weight:600;color:var(--navy);display:block;margin-bottom:4px}
.form-row{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:12px}
.form-group{margin-bottom:12px}
.err{color:var(--red);font-size:12px;margin-top:6px}
.tabs{display:flex;gap:0;border-bottom:2px solid var(--border);margin-bottom:20px}
.tab{padding:10px 20px;font-family:'Syne',Arial,sans-serif;font-size:14px;font-weight:700;letter-spacing:.02em;color:var(--slate);cursor:pointer;border-bottom:3px solid transparent;margin-bottom:-2px;transition:all .15s}
.tab.active{color:var(--navy);border-bottom-color:var(--teal)}
.tab-content{display:none}.tab-content.active{display:block}
.qblock{background:#fff;border:1px solid var(--border);border-left:3px solid var(--teal);border-radius:8px;padding:14px 16px;margin-bottom:12px}
.q-text{font-size:14px;font-weight:600;color:var(--navy);margin-bottom:8px}
.q-meta{font-size:11px;color:var(--slate);margin-bottom:8px}
.ans-si{background:#d1fae5;color:#065f46}.ans-no{background:#fee2e2;color:#991b1b}
.ans-parz{background:#fef3c7;color:#92400e}.ans-ns{background:#f1f5f9;color:#475569}.ans-na{background:#f1f5f9;color:#475569}
.ans-badge{font-size:11px;font-weight:700;padding:2px 8px;border-radius:4px;display:inline-block}
.vem-note-lbl{font-size:11px;font-weight:700;color:var(--green);margin-top:8px}
textarea{min-height:70px;resize:vertical}
.finding-row{display:flex;align-items:flex-start;gap:10px;padding:10px 14px;background:var(--bg);border-radius:7px;margin-bottom:8px;border:1px solid var(--border)}
.fr-title{font-size:13px;font-weight:600;color:var(--navy);flex:1}
.fr-area{font-size:10px;font-weight:700;margin-bottom:3px}
.owner-tag{font-size:10px;background:#e0e7ff;color:#3730a3;padding:1px 6px;border-radius:4px}
.rw-header{display:flex;align-items:center;gap:8px;padding:10px 14px;background:var(--bg);border:1px solid var(--border);border-radius:7px;cursor:pointer;margin-bottom:4px}
.rw-body{display:none;padding:12px 14px;background:#fff;border:1px solid var(--border);border-radius:0 0 7px 7px;margin-bottom:8px}
.rw-body.open{display:block}
.out-section{margin-bottom:24px}
.out-section h3{font-family:'Syne',Arial,sans-serif;font-size:15px;font-weight:700;letter-spacing:.04em;padding:10px 14px;background:var(--navy);color:#fff;border-radius:7px 7px 0 0;margin:0}
.roadmap-group{margin-bottom:16px}
.roadmap-group h4{font-size:12px;font-weight:700;padding:7px 12px;border-radius:5px;margin-bottom:8px}
.h4-qw{background:#fee2e2;color:#991b1b}.h4-mt{background:#fef3c7;color:#92400e}.h4-lt{background:#d1fae5;color:#065f46}
.ri{display:flex;align-items:center;gap:10px;padding:8px 10px;background:var(--bg);border-radius:6px;margin-bottom:5px}
.ri-n{width:20px;height:20px;background:var(--navy);color:#fff;border-radius:50%;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0}
@media print{.no-print{display:none!important}body{background:#fff}.hdr{display:none}}
</style>`;

// ── Setup page ─────────────────────────────────────────────────────────────────
function pageSetup(err) {
  return `<!DOCTYPE html><html><head>${CSS_BASE}<title>VEM Setup</title></head><body>
<div class="hdr"><div class="hdr-logo">${HDR_LOGO}<div class="hdr-divider"></div><span class="hdr-sub">AI Security Assessment — Setup iniziale</span></div></div>
<div class="app" style="max-width:480px;margin:60px auto">
<div class="card">
  <div class="card-title">Crea il primo account VEM</div>
  <div class="card-sub">Questo form appare solo la prima volta. Crea l'account amministratore.</div>
  ${err?`<div class="callout warn">${err}</div>`:''}
  <form method="POST" action="/vem/setup">
    <div class="form-group"><label>Username</label><input name="username" required placeholder="es. mario.rossi"></div>
    <div class="form-group"><label>Email</label><input name="email" type="email" placeholder="mario@vem.com"></div>
    <div class="form-group"><label>Password</label><input name="password" type="password" required placeholder="Minimo 8 caratteri"></div>
    <button class="btn btn-primary" type="submit" style="width:100%">Crea account e accedi</button>
  </form>
</div></div></body></html>`;
}

// ── Login page ─────────────────────────────────────────────────────────────────
function pageLogin(err, setup) {
  return `<!DOCTYPE html><html><head>${CSS_BASE}<title>VEM Login</title></head><body>
<div class="hdr"><div class="hdr-logo">${HDR_LOGO}<div class="hdr-divider"></div><span class="hdr-sub">AI Security Assessment</span></div></div>
<div class="app" style="max-width:420px;margin:80px auto">
<div class="card">
  <div style="text-align:center;margin-bottom:20px">
    <div style="display:inline-block;background:var(--galaxy);border-radius:50%;width:52px;height:52px;display:flex;align-items:center;justify-content:center;font-size:24px;margin:0 auto 12px">🔬</div>
    <div class="card-title" style="font-size:22px">Accesso VEM Analisti</div>
    <div class="card-sub">Area riservata al team VEM Sistemi</div></div>
  ${setup?`<div class="callout" style="margin-bottom:14px">✅ Account creato. Accedi con le credenziali appena impostate.</div>`:''}
  ${err?`<div class="callout warn">${err}</div>`:''}
  <form method="POST" action="/vem/login">
    <div class="form-group"><label>Username</label><input name="username" required autofocus></div>
    <div class="form-group"><label>Password</label><input name="password" type="password" required></div>
    <button class="btn btn-primary" type="submit" style="width:100%;justify-content:center">Accedi →</button>
  </form>
</div></div></body></html>`;
}

// ── Dashboard ─────────────────────────────────────────────────────────────────
function pageDashboard(username, subs) {
  const counts = { total: subs.length, pending: 0, reviewed: 0, completed: 0 };
  subs.forEach(s => { if(counts[s.status] !== undefined) counts[s.status]++; });

  const rows = subs.map(s => {
    const answered = Object.keys(s.answers||{}).length;
    const findings = (s.findings||[]).filter(f => !f.excluded).length;
    const crit = (s.findings||[]).filter(f => !f.excluded && f.rating==='CRITICO').length;
    return `<tr>
      <td><strong>${s.company?.name||'—'}</strong><br><span style="font-size:11px;color:var(--slate)">${s.company?.sector||''}</span></td>
      <td style="font-size:12px">${new Date(s.createdAt).toLocaleDateString('it-IT')}</td>
      <td>${statusBadge(s.status)}</td>
      <td style="text-align:center">${s.assets?.length||0}</td>
      <td style="text-align:center">${answered}</td>
      <td style="text-align:center">${findings>0?`${findings} ${crit>0?`<span style="color:var(--red);font-size:11px">(${crit} crit.)</span>`:''}`:'-'}</td>
      <td style="font-size:11px;color:var(--slate)">${s.reviewedBy||'—'}</td>
      <td><a href="/vem/submission/${s.id}" class="btn btn-primary btn-sm">Apri →</a></td>
    </tr>`;
  }).join('');

  return `<!DOCTYPE html><html><head>${CSS_BASE}<title>VEM Dashboard</title></head><body>
<div class="hdr">
  <div class="hdr-logo">${HDR_LOGO}<div class="hdr-divider"></div><span class="hdr-sub">AI Security Assessment — Dashboard</span></div>
  <div class="hdr-nav" style="display:flex;align-items:center">
    <a href="/vem">Dashboard</a>
    <a href="/vem/users">Utenti</a>
    <span class="hdr-user" style="margin-left:16px">👤 ${username}</span>
    <a href="/vem/logout" style="margin-left:16px;color:var(--pink)">Esci</a>
  </div>
</div>
<div class="app">
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px">
    <h1 style="font-size:20px;font-weight:800;color:var(--navy)">Assessment ricevuti</h1>
    <div style="display:flex;gap:10px">
      <a href="/" target="_blank" class="btn btn-secondary btn-sm">🔗 Link cliente</a>
    </div>
  </div>
  <div class="stats">
    <div class="stat"><div class="stat-n">${counts.total}</div><div class="stat-l">Totali</div></div>
    <div class="stat" style="border-top:3px solid var(--orange)"><div class="stat-n">${counts.pending}</div><div class="stat-l">In attesa</div></div>
    <div class="stat" style="border-top:3px solid var(--blue)"><div class="stat-n">${counts.reviewed}</div><div class="stat-l">In review</div></div>
    <div class="stat" style="border-top:3px solid var(--green)"><div class="stat-n">${counts.completed}</div><div class="stat-l">Completati</div></div>
  </div>
  ${subs.length===0?`<div class="callout">Nessun assessment ricevuto. Condividi il link della pagina cliente per iniziare.</div>`:`
  <div class="card" style="padding:0;overflow:hidden">
    <table>
      <thead><tr><th>Azienda</th><th>Data invio</th><th>Stato</th><th style="text-align:center">Asset AI</th><th style="text-align:center">Risposte</th><th style="text-align:center">Finding</th><th>Revisore</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`}
</div></body></html>`;
}

// ── Users page ────────────────────────────────────────────────────────────────
function pageUsers(username, users) {
  const rows = users.map(u => `<tr>
    <td><strong>${u.username}</strong></td>
    <td style="font-size:12px">${u.email||'—'}</td>
    <td style="font-size:12px">${new Date(u.createdAt).toLocaleDateString('it-IT')}</td>
    <td>
      ${users.length > 1 ? `<form method="POST" action="/vem/users/delete" style="display:inline" onsubmit="return confirm('Eliminare ${u.username}?')"><input type="hidden" name="id" value="${u.id}"><button class="btn btn-danger btn-sm" type="submit">Elimina</button></form>` : '<span style="font-size:11px;color:var(--slate)">Ultimo utente</span>'}
    </td></tr>`).join('');
  return `<!DOCTYPE html><html><head>${CSS_BASE}<title>Utenti VEM</title></head><body>
<div class="hdr">
  <div class="hdr-logo">${HDR_LOGO}<div class="hdr-divider"></div><span class="hdr-sub">Gestione utenti</span></div>
  <div class="hdr-nav"><a href="/vem">← Dashboard</a><a href="/vem/logout" style="color:var(--pink)">Esci</a></div>
</div>
<div class="app" style="max-width:800px">
  <h1 style="font-size:20px;font-weight:800;color:var(--navy);margin-bottom:20px">Utenti VEM</h1>
  <div class="card" style="padding:0;overflow:hidden;margin-bottom:20px">
    <table><thead><tr><th>Username</th><th>Email</th><th>Creato</th><th></th></tr></thead>
    <tbody>${rows}</tbody></table>
  </div>
  <div class="card">
    <div class="card-title">Aggiungi utente VEM</div>
    <form method="POST" action="/vem/users">
      <div class="form-row">
        <div class="form-group"><label>Username</label><input name="username" required placeholder="es. luigi.verdi"></div>
        <div class="form-group"><label>Email</label><input name="email" type="email" placeholder="luigi@vem.com"></div>
      </div>
      <div class="form-group"><label>Password</label><input name="password" type="password" required placeholder="Minimo 8 caratteri"></div>
      <button class="btn btn-primary" type="submit">Aggiungi utente</button>
    </form>
  </div>
</div></body></html>`;
}

// ── Submission detail page ─────────────────────────────────────────────────────
function pageSubmission(username, sub) {
  const c = sub.company || {};

  // Build answers review HTML
  const AREAS_DEF = [
    { key:'shadowAI',  label:'Shadow AI',          color:'#7C3AED', icon:'👥' },
    { key:'chatbot',   label:'Chatbot & RAG',       color:'#0A84D6', icon:'💬' },
    { key:'promptInj', label:'Prompt Injection',    color:'#EF4444', icon:'💉' },
    { key:'agents',    label:'Agenti AI',            color:'#F59E0B', icon:'⚙️' },
    { key:'euAiAct',   label:'EU AI Act',            color:'#059669', icon:'⚖️' },
    { key:'continuity',label:'Continuità',           color:'#0EA5E9', icon:'🔄' },
  ];
  const ANS_CLASSES = { 'Sì':'ans-si','No':'ans-no','Parziale':'ans-parz','Non so':'ans-ns','N/A':'ans-na','—':'ans-na' };

  const reviewHtml = AREAS_DEF.map(area => {
    const qkeys = Object.keys(sub.answers||{}).filter(k => k.startsWith(area.key+'_'));
    const allKeys = Array.from({length:20},(_,i)=>`${area.key}_${i}`);
    const relevantKeys = allKeys.filter(k => (sub.answers||{})[k] !== undefined);
    if (relevantKeys.length === 0) return '';

    const qBlocks = relevantKeys.map(key => {
      const val = (sub.answers||{})[key] || '—';
      const note = (sub.notes||{})[key] || '';
      const files = (sub.files||{})[key] || [];
      const vn = (sub.vemNotes||{})[key] || '';
      const cls = ANS_CLASSES[val] || 'ans-na';
      const qi = key.split('_')[1];
      return `<div class="qblock" style="border-left-color:${area.color}">
        <div class="q-meta">${area.label} · Domanda ${parseInt(qi)+1}</div>
        <div style="display:flex;align-items:flex-start;gap:10px">
          <div style="flex:1">
            <div style="font-size:11px;color:var(--slate);font-style:italic;margin-bottom:6px">Risposta cliente: <span class="ans-badge ${cls}">${val}</span></div>
            ${note?`<div style="font-size:12px;color:var(--slate);margin-bottom:6px;background:var(--bg);padding:6px 10px;border-radius:5px">📝 "${note}"</div>`:''}
            ${files.length?`<div style="font-size:11px;color:var(--slate);margin-bottom:6px">${files.map(f=>`📎 ${f.name}`).join(' · ')}</div>`:''}
          </div>
        </div>
        <div class="vem-note-lbl">🔬 Nota tecnica VEM:</div>
        <textarea data-key="${key}" class="vem-note" placeholder="Evidenze tecniche, esito verifiche, discordanze..." onchange="setVemNote('${key}',this.value)">${vn}</textarea>
        <div style="margin-top:6px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <span style="font-size:11px;color:var(--slate)">Override:</span>
          ${['Sì','Parziale','No','N/A'].map(v=>`<label style="display:flex;align-items:center;gap:4px;font-size:12px;cursor:pointer">
            <input type="radio" name="ov-${key}" value="${v}" ${val===v?'checked':''} onchange="overrideAns('${key}','${v}')"> ${v}</label>`).join('')}
        </div>
      </div>`;
    }).join('');

    return `<div style="margin-bottom:20px">
      <div style="display:flex;align-items:center;gap:8px;padding:10px 14px;background:var(--bg);border-radius:8px;margin-bottom:10px;border-left:3px solid ${area.color}">
        <span style="font-size:18px">${area.icon}</span>
        <strong style="font-size:14px;color:var(--navy)">${area.label}</strong>
        <span style="font-size:11px;color:var(--slate);margin-left:auto">${relevantKeys.length} domande</span>
      </div>
      ${qBlocks}
    </div>`;
  }).join('');

  // Assets table
  const assetsHtml = (sub.assets||[]).length === 0
    ? '<div style="font-size:13px;color:var(--slate);font-style:italic">Nessun asset censito</div>'
    : `<table><thead><tr><th>#</th><th>Nome</th><th>Categoria</th><th>Owner</th><th>Utenti</th><th>Dati trattati</th><th>Note</th></tr></thead>
       <tbody>${(sub.assets||[]).map((a,i)=>`<tr><td>${i+1}</td><td><strong>${a.name}</strong></td><td>${a.catLabel||a.cat}</td><td>${a.owner||'—'}</td><td>${a.users||'—'}</td><td>${a.data||'—'}</td><td>${a.notes||'—'}</td></tr>`).join('')}</tbody></table>`;

  // Findings
  const activeF = (sub.findings||[]).filter(f=>!f.excluded);
  const fcounts = {CRITICO:0,ALTO:0,MEDIO:0,BASSO:0};
  activeF.forEach(f=>{ if(fcounts[f.rating]!==undefined) fcounts[f.rating]++; });
  const sorted = [...activeF].sort((a,b)=>RATING_ORDER.indexOf(a.rating)-RATING_ORDER.indexOf(b.rating));

  const findingsTableHtml = sorted.length === 0
    ? '<div class="callout warn">Nessun finding generato. Completa la review e clicca "Genera finding".</div>'
    : `<table><thead><tr><th>ID</th><th>Area</th><th>Finding</th><th>Prob.</th><th>Impatto</th><th>Rating</th><th>Owner</th><th>Nota VEM</th></tr></thead>
       <tbody>${sorted.map((f,i)=>`<tr>
         <td><strong>AI-${String(i+1).padStart(3,'0')}</strong></td>
         <td><span style="font-size:10px;font-weight:700;color:${AREA_COLORS[f.area]||'#333'}">${AREA_LABELS[f.area]||f.area}</span></td>
         <td>${f.title}</td><td>${f.prob}</td><td>${f.impact}</td>
         <td>${ratingBadge(f.rating)}</td>
         <td><span class="owner-tag">${f.owner}</span></td>
         <td style="font-size:11px;color:var(--slate)">${(sub.vemNotes||{})[f.srcKey]||f.internalNote||'—'}</td>
       </tr>`).join('')}</tbody></table>`;

  // Output report
  const qw = sorted.filter(f=>f.rating==='CRITICO'||f.rating==='ALTO');
  const mt = sorted.filter(f=>f.rating==='MEDIO');
  const lt = sorted.filter(f=>f.rating==='BASSO');

  const roadmapHtml = `
  <div class="roadmap-group"><h4 class="h4-qw">⚡ Quick Win — 0/30 giorni (${qw.length})</h4>
    ${qw.map((f,i)=>`<div class="ri"><div class="ri-n">${i+1}</div><div style="flex:1"><strong style="font-size:13px">${f.title}</strong><div style="font-size:11px;color:var(--slate);margin-top:2px">${AREA_LABELS[f.area]||f.area} · <span class="owner-tag">${f.owner}</span></div></div>${ratingBadge(f.rating)}</div>`).join('')||'<div style="font-size:13px;color:var(--slate);font-style:italic">Nessuno</div>'}
  </div>
  <div class="roadmap-group"><h4 class="h4-mt">📅 Mid-term — 1/3 mesi (${mt.length})</h4>
    ${mt.map((f,i)=>`<div class="ri"><div class="ri-n">${i+1}</div><div style="flex:1"><strong style="font-size:13px">${f.title}</strong><div style="font-size:11px;color:var(--slate);margin-top:2px">${AREA_LABELS[f.area]||f.area} · <span class="owner-tag">${f.owner}</span></div></div>${ratingBadge(f.rating)}</div>`).join('')||'<div style="font-size:13px;color:var(--slate);font-style:italic">Nessuno</div>'}
  </div>
  <div class="roadmap-group"><h4 class="h4-lt">🎯 Long-term — 3/12 mesi (${lt.length})</h4>
    ${lt.map((f,i)=>`<div class="ri"><div class="ri-n">${i+1}</div><div style="flex:1"><strong style="font-size:13px">${f.title}</strong><div style="font-size:11px;color:var(--slate);margin-top:2px">${AREA_LABELS[f.area]||f.area} · <span class="owner-tag">${f.owner}</span></div></div>${ratingBadge(f.rating)}</div>`).join('')||'<div style="font-size:13px;color:var(--slate);font-style:italic">Nessuno</div>'}
  </div>`;

  return `<!DOCTYPE html><html><head>${CSS_BASE}
<title>${c.name||'Assessment'} — VEM</title>
<style>
#toast{position:fixed;bottom:20px;right:20px;background:var(--green);color:#fff;padding:10px 18px;border-radius:8px;font-size:13px;font-weight:600;display:none;z-index:999;box-shadow:0 4px 14px rgba(0,0,0,.2)}
.fc-excl-btn{font-size:11px;padding:3px 8px;border-radius:4px;border:1px solid var(--border);background:#fff;cursor:pointer;color:var(--red)}
.fc-excl-btn.excl{color:var(--green);border-color:var(--green)}
</style>
</head><body>
<div id="toast">✅ Salvato!</div>
<div class="hdr">
  <div class="hdr-logo">${HDR_LOGO}<div class="hdr-divider"></div><span class="hdr-sub">Assessment: <strong style="color:#fff">${c.name||'—'}</strong></span><span style="margin-left:8px">${statusBadge(sub.status)}</span></div>
  <div class="hdr-nav" style="display:flex;align-items:center;gap:12px">
    <select id="statusSel" style="padding:4px 8px;font-size:12px;border-radius:5px;border:1px solid rgba(255,255,255,.2);background:rgba(255,255,255,.08);color:rgba(255,255,255,.8);cursor:pointer;font-family:inherit" onchange="setStatus(this.value)">
      <option value="pending"   ${sub.status==='pending'?'selected':''}>In attesa</option>
      <option value="reviewed"  ${sub.status==='reviewed'?'selected':''}>In review</option>
      <option value="completed" ${sub.status==='completed'?'selected':''}>Completato</option>
    </select>
    <a href="/vem" class="btn btn-secondary btn-sm">← Dashboard</a>
    <a href="/vem/logout" style="font-size:12px;color:var(--pink);text-decoration:none">Esci</a>
  </div>
</div>

<div class="app">
  <!-- Info cliente -->
  <div class="card" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;padding:16px 20px">
    ${[['Azienda',c.name],['Settore',c.sector],['Dimensione',c.size],['Referente IT',c.it],['CISO',c.ciso],['DPO/Legal',c.legal],['Data compilazione',c.date],['Consulente VEM',c.consultant]].map(([l,v])=>v?`<div><div style="font-size:10px;font-weight:700;color:var(--slate);letter-spacing:.05em;margin-bottom:2px">${l.toUpperCase()}</div><div style="font-size:13px;font-weight:600;color:var(--navy)">${v}</div></div>`:'').filter(Boolean).join('')}
  </div>

  <!-- Stats -->
  <div class="stats">
    <div class="stat"><div class="stat-n">${(sub.assets||[]).length}</div><div class="stat-l">Asset AI</div></div>
    <div class="stat"><div class="stat-n">${Object.keys(sub.answers||{}).length}</div><div class="stat-l">Risposte</div></div>
    <div class="stat c"><div class="stat-n">${fcounts.CRITICO}</div><div class="stat-l">Critici</div></div>
    <div class="stat a"><div class="stat-n">${fcounts.ALTO}</div><div class="stat-l">Alti</div></div>
    <div class="stat m"><div class="stat-n">${fcounts.MEDIO}</div><div class="stat-l">Medi</div></div>
    <div class="stat"><div class="stat-n">${fcounts.BASSO}</div><div class="stat-l">Bassi</div></div>
  </div>

  <!-- Tabs -->
  <div class="tabs">
    <div class="tab active" onclick="switchTab('tab-review',this)">🔬 Review risposte</div>
    <div class="tab" onclick="switchTab('tab-findings',this)">⚠ Finding</div>
    <div class="tab" onclick="switchTab('tab-output',this)">📄 Report finale</div>
    <div class="tab" onclick="switchTab('tab-assets',this)">📋 Asset AI</div>
  </div>

  <!-- Tab: Review -->
  <div id="tab-review" class="tab-content active">
    <div class="callout">Integra le risposte del cliente con le verifiche tecniche. Le note VEM appariranno nel report finale.</div>
    <div style="display:flex;justify-content:flex-end;margin-bottom:14px;gap:10px">
      <button class="btn btn-secondary btn-sm" onclick="saveAll()">💾 Salva note</button>
      <button class="btn btn-primary btn-sm" onclick="generateFindings()">⚡ Genera finding →</button>
    </div>
    ${reviewHtml}
    <div style="display:flex;justify-content:flex-end;margin-top:10px;gap:10px">
      <button class="btn btn-secondary" onclick="saveAll()">💾 Salva note</button>
      <button class="btn btn-primary" onclick="generateFindings()">⚡ Genera finding →</button>
    </div>
  </div>

  <!-- Tab: Finding -->
  <div id="tab-findings" class="tab-content">
    <div class="callout">Valida, modifica il rating o escludi i finding. Puoi aggiungere finding manuali.</div>
    <div style="display:flex;justify-content:flex-end;margin-bottom:14px;gap:10px">
      <button class="btn btn-secondary btn-sm" onclick="addManualFinding()">+ Aggiungi manuale</button>
      <button class="btn btn-secondary btn-sm" onclick="saveAll()">💾 Salva</button>
    </div>
    <div id="findings-list"></div>
    <button onclick="addManualFinding()" style="display:flex;align-items:center;gap:8px;padding:10px 16px;border:2px dashed var(--border);border-radius:8px;color:var(--slate);background:none;cursor:pointer;font-size:13px;width:100%;margin-top:8px">+ Aggiungi finding manuale</button>
    <div style="margin-top:14px;display:flex;justify-content:flex-end;gap:10px">
      <button class="btn btn-secondary" onclick="saveAll()">💾 Salva finding</button>
      <button class="btn btn-primary" onclick="switchTabById('tab-output')">Vai al report →</button>
    </div>
  </div>

  <!-- Tab: Output -->
  <div id="tab-output" class="tab-content">
    <div class="no-print" style="display:flex;gap:10px;margin-bottom:18px">
      <button class="btn btn-primary" onclick="window.print()">🖨 Stampa / Salva PDF</button>
      <button class="btn btn-secondary" onclick="saveAll()">💾 Salva stato</button>
    </div>
    <!-- Intestazione report -->
    <div class="card" style="background:var(--navy);border:none;color:#fff;margin-bottom:16px">
      <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:10px">
        <div>
          <div style="font-size:10px;letter-spacing:.12em;color:#9DB8D2;font-weight:700">VEM SISTEMI — AI SECURITY ASSESSMENT</div>
          <div style="font-size:22px;font-weight:800;margin:4px 0">Report di Assessment</div>
          <div style="font-size:14px;color:#9DB8D2">${c.name||'—'} · ${c.sector||''}</div>
        </div>
        <div style="text-align:right;font-size:12px;color:#9DB8D2">
          <div>Data: ${c.date||new Date().toLocaleDateString('it-IT')}</div>
          <div>VEM: ${c.consultant||username}</div>
          <div>Referente: ${c.it||'—'}</div>
        </div>
      </div>
    </div>
    <div class="stats" style="margin-bottom:16px">
      <div class="stat"><div class="stat-n">${(sub.assets||[]).length}</div><div class="stat-l">Asset AI</div></div>
      <div class="stat"><div class="stat-n">${sorted.length}</div><div class="stat-l">Finding totali</div></div>
      <div class="stat c"><div class="stat-n">${fcounts.CRITICO}</div><div class="stat-l">Critici</div></div>
      <div class="stat a"><div class="stat-n">${fcounts.ALTO}</div><div class="stat-l">Alti</div></div>
      <div class="stat m"><div class="stat-n">${fcounts.MEDIO}</div><div class="stat-l">Medi</div></div>
      <div class="stat"><div class="stat-n">${fcounts.BASSO}</div><div class="stat-l">Bassi</div></div>
    </div>
    <div class="out-section">
      <h3>📋 AI Asset Inventory</h3>
      <div style="padding:0;background:#fff;border:1px solid var(--border);border-radius:0 0 8px 8px;overflow:hidden">${assetsHtml}</div>
    </div>
    <div class="out-section">
      <h3>⚠ Finding e Risk Matrix</h3>
      <div style="padding:0;background:#fff;border:1px solid var(--border);border-radius:0 0 8px 8px;overflow:hidden" id="report-findings-table">${findingsTableHtml}</div>
    </div>
    <div class="out-section">
      <h3>🗺 Remediation Roadmap</h3>
      <div style="padding:16px;background:#fff;border:1px solid var(--border);border-radius:0 0 8px 8px" id="report-roadmap">${roadmapHtml}</div>
    </div>
  </div>

  <!-- Tab: Asset -->
  <div id="tab-assets" class="tab-content">
    <div class="card" style="padding:0;overflow:hidden">${assetsHtml}</div>
  </div>
</div>

<script>
// ── State ──────────────────────────────────────────────────────────────────────
const SUB_ID = '${sub.id}';
let state = {
  answers: ${JSON.stringify(sub.answers||{})},
  vemNotes: ${JSON.stringify(sub.vemNotes||{})},
  findings: ${JSON.stringify(sub.findings||[])},
  status: '${sub.status}'
};

const RATING_MAP = {
  'Alta+Critico':'CRITICO','Alta+Alto':'CRITICO','Alta+Medio':'ALTO','Alta+Basso':'MEDIO',
  'Media+Critico':'ALTO','Media+Alto':'ALTO','Media+Medio':'MEDIO','Media+Basso':'BASSO',
  'Bassa+Critico':'MEDIO','Bassa+Alto':'MEDIO','Bassa+Medio':'BASSO','Bassa+Basso':'BASSO'
};
const RATING_ORDER = ${JSON.stringify(RATING_ORDER)};
const AREAS_DATA = ${JSON.stringify(
  [
    {key:'shadowAI', label:'Shadow AI', color:'#7C3AED',
     questions:[
       {q:'È stata effettuata un\'analisi del traffico DNS o proxy per identificare tool AI non autorizzati?',finding:'Assenza di monitoraggio DNS/proxy per rilevare Shadow AI',prob:'Alta',impact:'Alto',owner:'IT/CISO'},
       {q:'Esiste una policy aziendale che regola l\'uso degli strumenti AI da parte dei dipendenti?',finding:'Policy AI assente — nessuna regolamentazione sull\'uso di tool AI da parte dei dipendenti',prob:'Alta',impact:'Alto',owner:'HR/Legal'},
       {q:'È stato comunicato ai dipendenti quali strumenti AI sono approvati e quali vietati?',finding:'Comunicazione insufficiente ai dipendenti riguardo ai tool AI approvati/vietati',prob:'Alta',impact:'Medio',owner:'HR/Management'},
       {q:'Esiste un processo formale di approvazione per l\'adozione di nuovi strumenti AI?',finding:'Nessun processo formale di approvazione per l\'adozione di nuovi tool AI',prob:'Alta',impact:'Alto',owner:'IT/Management'},
       {q:'Sono stati rilevati o segnalati casi di utilizzo di AI esterna per elaborare dati aziendali sensibili?',finding:'Casi documentati di elaborazione di dati sensibili su piattaforme AI non autorizzate',prob:'Media',impact:'Critico',owner:'CISO'},
       {q:'Sono in uso soluzioni CASB (Cloud Access Security Broker) o DLP (Data Loss Prevention) per monitorare il traffico verso servizi AI cloud?',finding:'Assenza di soluzioni CASB/DLP per il controllo dell\'accesso ai servizi AI cloud',prob:'Alta',impact:'Critico',owner:'IT/CISO'},
     ]},
    {key:'chatbot', label:'Chatbot & RAG', color:'#0A84D6',
     questions:[
       {q:'I chatbot AI interni hanno accesso a basi di conoscenza (SharePoint, Confluence, database) contenenti dati sensibili o riservati?',finding:'Chatbot AI con accesso indiscriminato a knowledge base contenenti dati sensibili',prob:'Alta',impact:'Critico',owner:'IT/CISO'},
       {q:'È stato implementato un sistema di controllo degli accessi (RBAC) sulla knowledge base del chatbot?',finding:'Assenza di RBAC sulla knowledge base RAG — accesso non segmentato per ruolo/utente',prob:'Alta',impact:'Critico',owner:'IT'},
       {q:'I documenti caricati nella knowledge base RAG sono stati classificati per livello di riservatezza?',finding:'Documenti nella knowledge base non classificati per livello di riservatezza',prob:'Media',impact:'Alto',owner:'IT/Compliance'},
       {q:'Viene effettuato un monitoraggio delle domande poste al chatbot per rilevare tentativi di estrazione di informazioni non autorizzate?',finding:'Nessun monitoraggio delle query al chatbot per rilevare tentativi di data extraction',prob:'Media',impact:'Alto',owner:'IT/CISO'},
       {q:'I contratti con il provider del chatbot AI specificano che i dati non vengono usati per il training del modello?',finding:'Contratti con provider AI privi di clausole di opt-out dal training sui dati aziendali',prob:'Alta',impact:'Critico',owner:'Legal/DPO'},
       {q:'È stato condotto un test di sicurezza (red team o penetration test) sul chatbot per verificarne la robustezza?',finding:'Nessun security testing effettuato sul chatbot AI in produzione',prob:'Media',impact:'Alto',owner:'IT/CISO'},
     ]},
    {key:'promptInj', label:'Prompt Injection', color:'#EF4444',
     questions:[
       {q:'I sistemi AI che elaborano documenti esterni (email, PDF, file caricati dagli utenti) sono stati testati contro attacchi di prompt injection indiretta?',finding:'Sistemi AI vulnerabili a prompt injection indiretta tramite documenti/file esterni',prob:'Media',impact:'Critico',owner:'IT/CISO'},
       {q:'Gli agenti AI o assistenti che elaborano contenuti web (scraping, ricerche) hanno meccanismi di sanitizzazione degli input?',finding:'Agenti AI privi di sanitizzazione input — vulnerabili a injection da contenuti web',prob:'Alta',impact:'Alto',owner:'IT'},
       {q:'I system prompt dei principali sistemi AI in produzione sono stati testati contro tecniche di jailbreak?',finding:'System prompt non testati contro tecniche di jailbreak note',prob:'Media',impact:'Alto',owner:'IT/CISO'},
       {q:'Esiste un sistema di logging e auditing delle interazioni con i sistemi AI per rilevare e investigare incidenti?',finding:'Assenza di logging/auditing delle interazioni AI — impossibile investigare incidenti',prob:'Alta',impact:'Alto',owner:'IT'},
       {q:'I sistemi AI che invocano tool o API esterne applicano il principio del least privilege?',finding:'Sistemi AI con permessi eccessivi verso tool/API — rischio di privilege escalation',prob:'Alta',impact:'Critico',owner:'IT/CISO'},
     ]},
    {key:'agents', label:'Agenti AI', color:'#F59E0B',
     questions:[
       {q:'Per le azioni ad alto impatto (invio email, esecuzione transazioni, modifica dati), gli agenti AI richiedono approvazione umana (human-in-the-loop)?',finding:'Agenti AI eseguono azioni critiche senza approvazione umana (human-in-the-loop)',prob:'Alta',impact:'Critico',owner:'IT/Business'},
       {q:'I workflow degli agenti AI sono documentati, inclusi i tool disponibili, i dati accessibili e i limiti operativi?',finding:'Workflow degli agenti AI non documentati — mancanza di visibilità sulle azioni possibili',prob:'Media',impact:'Alto',owner:'IT'},
       {q:'Esiste un meccanismo per bloccare o interrompere un agente AI in caso di comportamento anomalo?',finding:'Nessun meccanismo di kill switch o circuit breaker per gli agenti AI in produzione',prob:'Media',impact:'Critico',owner:'IT'},
       {q:'Le credenziali usate dagli agenti AI per accedere a sistemi e API sono gestite con un vault dedicato (es. HashiCorp Vault, AWS Secrets Manager)?',finding:'Credenziali degli agenti AI non gestite con secret management dedicato',prob:'Alta',impact:'Alto',owner:'IT/CISO'},
       {q:'Sono stati definiti limiti di spesa, rate limit e alert per le chiamate API degli agenti AI?',finding:'Nessun limite di spesa o rate limiting per le API degli agenti AI — rischio di runaway costs',prob:'Media',impact:'Medio',owner:'IT/Finance'},
     ]},
    {key:'euAiAct', label:'EU AI Act', color:'#059669',
     questions:[
       {q:'È stata effettuata una classificazione dei sistemi AI in uso secondo le categorie di rischio dell\'EU AI Act (proibiti, alto rischio, limitato, minimo)?',finding:'Nessuna classificazione dei sistemi AI secondo le categorie di rischio EU AI Act',prob:'Alta',impact:'Alto',owner:'Legal/Compliance'},
       {q:'Per i sistemi AI classificati ad alto rischio, è stata predisposta la documentazione tecnica richiesta dall\'EU AI Act?',finding:'Documentazione tecnica insufficiente per i sistemi AI ad alto rischio',prob:'Media',impact:'Alto',owner:'IT/Legal'},
       {q:'Sono stati firmati DPA con tutti i provider AI utilizzati in produzione?',finding:'DPA mancanti o incompleti con uno o più provider AI in produzione',prob:'Alta',impact:'Critico',owner:'Legal/DPO'},
       {q:'È stato nominato un responsabile interno per la conformità AI (AI Officer, DPO con delega AI, o equivalente)?',finding:'Nessun responsabile interno nominato per la governance e compliance AI',prob:'Alta',impact:'Medio',owner:'Management'},
       {q:'Esiste un registro aggiornato di tutti i sistemi AI in uso nell\'organizzazione (AI Registry)?',finding:'Assenza di AI Registry — inventario strutturato dei sistemi AI in uso',prob:'Alta',impact:'Alto',owner:'CISO/AI Officer'},
       {q:'L\'organizzazione ha avviato una valutazione di impatto sui diritti fondamentali per i sistemi AI ad alto rischio (FRIA)?',finding:'Nessuna FRIA (Fundamental Rights Impact Assessment) per sistemi AI ad alto rischio',prob:'Bassa',impact:'Alto',owner:'Legal/DPO'},
     ]},
    {key:'continuity', label:'Continuità', color:'#0EA5E9',
     questions:[
       {q:'Per ogni processo aziendale che dipende dall\'AI, esiste una procedura di fallback manuale documentata?',finding:'Processi critici dipendenti dall\'AI privi di fallback manuale documentato',prob:'Media',impact:'Critico',owner:'IT/Business'},
       {q:'Gli SLA dei vendor AI principali sono stati verificati, documentati e considerati accettabili?',finding:'SLA dei vendor AI non verificati o non documentati per i processi critici',prob:'Media',impact:'Alto',owner:'IT/Legal'},
       {q:'Esiste un piano per gestire la deprecazione dei modelli AI usati in produzione?',finding:'Nessun piano per la gestione della deprecazione dei modelli AI in produzione',prob:'Media',impact:'Alto',owner:'IT'},
       {q:'È attivo un monitoraggio della qualità degli output AI nel tempo (rilevamento di model drift o degrado delle risposte)?',finding:'Nessun monitoraggio del model drift e della qualità degli output AI nel tempo',prob:'Media',impact:'Medio',owner:'IT/Data Team'},
       {q:'Per i modelli AI self-hosted sono stati applicati gli aggiornamenti di sicurezza recenti?',finding:'Modelli AI self-hosted non aggiornati o con patch di sicurezza arretrate',prob:'Bassa',impact:'Alto',owner:'IT'},
       {q:'Il Business Continuity Plan aziendale è stato aggiornato per includere scenari di failure dei sistemi AI critici?',finding:'BCP aziendale non aggiornato con scenari di failure dei sistemi AI critici',prob:'Media',impact:'Alto',owner:'IT/Business'},
     ]},
  ]
)};

function downgrade(r){const idx=RATING_ORDER.indexOf(r);return RATING_ORDER[Math.min(idx+1,RATING_ORDER.length-1)];}

// ── Tab switch ─────────────────────────────────────────────────────────────────
function switchTab(id, el){
  document.querySelectorAll('.tab-content').forEach(t=>t.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  if(el) el.classList.add('active');
  if(id==='tab-findings') renderFindingsList();
  if(id==='tab-output') refreshOutput();
}
function switchTabById(id){
  switchTab(id, document.querySelector('.tabs .tab:nth-child('+(id==='tab-review'?1:id==='tab-findings'?2:id==='tab-output'?3:4)+')'));
}

// ── VEM notes / overrides ──────────────────────────────────────────────────────
function setVemNote(key,val){state.vemNotes[key]=val;}
function overrideAns(key,val){state.answers[key]=val;}
function setStatus(val){state.status=val;}

// ── Generate findings ──────────────────────────────────────────────────────────
function generateFindings(){
  state.findings=[];
  AREAS_DATA.forEach(area=>{
    area.questions.forEach((item,qi)=>{
      const key=area.key+'_'+qi;
      const val=state.answers[key];
      if(val==='No'||val==='Parziale'||val==='Non so'){
        const base=RATING_MAP[item.prob+'+'+item.impact]||'MEDIO';
        const rating=val==='Parziale'?downgrade(base):val==='Non so'?downgrade(downgrade(base)):base;
        state.findings.push({area:area.key,title:item.finding,prob:item.prob,impact:item.impact,rating,owner:item.owner,excluded:false,srcKey:key,internalNote:''});
      }
    });
  });
  saveAll();
  switchTabById('tab-findings');
}

// ── Render findings list ───────────────────────────────────────────────────────
const AREA_COLORS_JS = ${JSON.stringify(AREA_COLORS)};
const AREA_LABELS_JS = ${JSON.stringify(AREA_LABELS)};
const RB_COLORS = {CRITICO:'#EF4444',ALTO:'#F59E0B',MEDIO:'#3B82F6',BASSO:'#6B7280'};

function rb(r){return '<span style="background:'+(RB_COLORS[r]||'#ccc')+';color:#fff;font-size:10px;font-weight:700;padding:2px 8px;border-radius:4px">'+r+'</span>';}

function renderFindingsList(){
  const el=document.getElementById('findings-list');
  if(!el) return;
  if(state.findings.length===0){el.innerHTML='<div class="callout warn">Nessun finding. Torna alla tab Review e clicca "Genera finding".</div>';return;}
  el.innerHTML=state.findings.map((f,i)=>{
    if(f.excluded) return '<div class="finding-row" style="opacity:.45;text-decoration:line-through"><div style="flex:1"><div class="fr-area" style="color:'+(AREA_COLORS_JS[f.area]||'#333')+'">'+AREA_LABELS_JS[f.area]+'</div><div class="fr-title">'+f.title+'</div></div>'+rb(f.rating)+'<button class="fc-excl-btn excl" onclick="toggleExcl('+i+')">✓ Re-includi</button></div>';
    return '<div class="finding-row"><div style="flex:1">'+
      '<div class="fr-area" style="color:'+(AREA_COLORS_JS[f.area]||'#333')+'">'+AREA_LABELS_JS[f.area]+'</div>'+
      '<div class="fr-title">'+f.title+'</div>'+
      '<div style="margin-top:6px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">'+
      '<select style="padding:3px 6px;font-size:11px;border-radius:4px;border:1px solid #ddd" onchange="updateF('+i+',\'prob\',this.value)">'+['Alta','Media','Bassa'].map(v=>'<option '+(f.prob===v?'selected':'')+'>'+v+'</option>').join('')+'</select>'+
      '<select style="padding:3px 6px;font-size:11px;border-radius:4px;border:1px solid #ddd" onchange="updateF('+i+',\'impact\',this.value)">'+['Critico','Alto','Medio','Basso'].map(v=>'<option '+(f.impact===v?'selected':'')+'>'+v+'</option>').join('')+'</select>'+
      '<select style="padding:3px 6px;font-size:11px;border-radius:4px;border:1px solid #ddd" onchange="updateF('+i+',\'rating\',this.value)">'+['CRITICO','ALTO','MEDIO','BASSO'].map(v=>'<option '+(f.rating===v?'selected':'')+'>'+v+'</option>').join('')+'</select>'+
      '<span class="owner-tag">'+f.owner+'</span>'+
      '<input style="padding:3px 8px;font-size:11px;border:1px solid #ddd;border-radius:4px;max-width:180px" placeholder="Nota interna..." value="'+(f.internalNote||'')+'" onchange="updateF('+i+',\'internalNote\',this.value)">'+
      '</div></div>'+rb(f.rating)+'<button class="fc-excl-btn" onclick="toggleExcl('+i+')">✕ Escludi</button></div>';
  }).join('');
}
function toggleExcl(i){state.findings[i].excluded=!state.findings[i].excluded;renderFindingsList();}
function updateF(i,field,val){state.findings[i][field]=val;}
function addManualFinding(){
  const t=prompt('Titolo del finding:');if(!t)return;
  const ak=prompt('Codice area (shadowAI/chatbot/promptInj/agents/euAiAct/continuity):','shadowAI');
  state.findings.push({area:ak||'shadowAI',title:t,prob:'Media',impact:'Alto',rating:'ALTO',owner:'IT',excluded:false,srcKey:'manual',internalNote:''});
  renderFindingsList();
}

// ── Refresh output tab ─────────────────────────────────────────────────────────
function refreshOutput(){
  const active=state.findings.filter(f=>!f.excluded);
  const sorted=[...active].sort((a,b)=>['CRITICO','ALTO','MEDIO','BASSO'].indexOf(a.rating)-['CRITICO','ALTO','MEDIO','BASSO'].indexOf(b.rating));
  const qw=sorted.filter(f=>f.rating==='CRITICO'||f.rating==='ALTO');
  const mt=sorted.filter(f=>f.rating==='MEDIO');
  const lt=sorted.filter(f=>f.rating==='BASSO');
  // Update findings table
  const tbl=document.getElementById('report-findings-table');
  if(tbl){
    if(sorted.length===0){tbl.innerHTML='<div style="padding:14px;font-style:italic;color:var(--slate)">Nessun finding attivo.</div>';return;}
    tbl.innerHTML='<table><thead><tr><th>ID</th><th>Area</th><th>Finding</th><th>Prob.</th><th>Impatto</th><th>Rating</th><th>Owner</th><th>Nota VEM</th></tr></thead><tbody>'+
      sorted.map((f,i)=>'<tr><td><strong>AI-'+String(i+1).padStart(3,'0')+'</strong></td>'+
        '<td><span style="font-size:10px;font-weight:700;color:'+(AREA_COLORS_JS[f.area]||'#333')+'">'+AREA_LABELS_JS[f.area]+'</span></td>'+
        '<td>'+f.title+'</td><td>'+f.prob+'</td><td>'+f.impact+'</td>'+
        '<td>'+rb(f.rating)+'</td><td><span class="owner-tag">'+f.owner+'</span></td>'+
        '<td style="font-size:11px;color:var(--slate)">'+(state.vemNotes[f.srcKey]||f.internalNote||'—')+'</td></tr>').join('')+
      '</tbody></table>';
  }
  // Update roadmap
  const road=document.getElementById('report-roadmap');
  if(road){
    const g=(list,cls,lbl)=>'<div class="roadmap-group"><h4 class="'+cls+'">'+lbl+' ('+list.length+')</h4>'+
      (list.map((f,i)=>'<div class="ri"><div class="ri-n">'+(i+1)+'</div><div style="flex:1"><strong style="font-size:13px">'+f.title+'</strong><div style="font-size:11px;color:var(--slate);margin-top:2px">'+AREA_LABELS_JS[f.area]+' · <span class="owner-tag">'+f.owner+'</span></div></div>'+rb(f.rating)+'</div>').join('')||'<div style="font-size:13px;color:var(--slate);font-style:italic">Nessuno</div>')+'</div>';
    road.innerHTML=g(qw,'h4-qw','⚡ Quick Win — 0/30 giorni')+g(mt,'h4-mt','📅 Mid-term — 1/3 mesi')+g(lt,'h4-lt','🎯 Long-term — 3/12 mesi');
  }
}

// ── Save ───────────────────────────────────────────────────────────────────────
async function saveAll(){
  const res=await fetch('/vem/submission/'+SUB_ID+'/save',{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({vemNotes:state.vemNotes,findings:state.findings,status:state.status})
  });
  if(res.ok){showToast();}
}
function showToast(){const t=document.getElementById('toast');t.style.display='block';setTimeout(()=>t.style.display='none',2500);}

// ── Init ───────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded',()=>{
  renderFindingsList();
  // Auto-save on status change
});
</script>
</body></html>`;
}

// ══════════════════════════════════════════════════════════════════════════════
// START
// ══════════════════════════════════════════════════════════════════════════════
app.listen(PORT, () => {
  console.log(`\n🚀 VEM AI Assessment Platform avviata su http://localhost:${PORT}`);
  console.log(`   Pagina cliente:  http://localhost:${PORT}/`);
  console.log(`   Dashboard VEM:   http://localhost:${PORT}/vem`);
  const users = readUsers();
  if (users.length === 0) {
    console.log(`\n⚠  Primo avvio — crea il primo utente su: http://localhost:${PORT}/vem/setup`);
  }
  console.log('');
});
