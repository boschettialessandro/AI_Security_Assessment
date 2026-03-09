# VEM AI Security Assessment — Platform

Webapp per la raccolta e l'analisi degli assessment di sicurezza AI.

## Struttura

```
/
├── server.js          ← Server Express (backend + pagine VEM)
├── package.json
├── .env.example       ← Variabili d'ambiente (copia in .env)
├── public/
│   └── client.html    ← Pagina cliente (questionario)
└── data/              ← Dati (creata automaticamente)
    ├── users.json
    └── submissions/
```

## Avvio in locale

```bash
# 1. Installa dipendenze
npm install

# 2. Copia e configura .env
cp .env.example .env
# Modifica SESSION_SECRET con una stringa random

# 3. Avvia
npm start

# 4. Apri il browser
# Pagina cliente:  http://localhost:3000
# Dashboard VEM:   http://localhost:3000/vem
# (Prima volta: http://localhost:3000/vem/setup per creare l'utente admin)
```

## Deploy su Railway

1. Crea un account su [railway.app](https://railway.app)
2. Crea un nuovo progetto → **Deploy from GitHub repo**
3. Connetti il repo GitHub con il codice
4. Aggiungi le variabili d'ambiente in **Variables**:
   - `SESSION_SECRET` → stringa random (es. genera con `openssl rand -hex 32`)
   - `DATA_DIR` → `/data` (vedi punto 5)
5. Aggiungi un **Volume** al servizio:
   - Mount path: `/data`
   - Questo garantisce la persistenza dei dati tra i deploy
6. Deploy! Railway rileva automaticamente Node.js e usa `npm start`

### URL della app
- Railway assegna automaticamente un dominio tipo `https://vem-assessment-xxx.railway.app`
- Pagina cliente: `https://tuodominio.railway.app/`
- Dashboard VEM: `https://tuodominio.railway.app/vem`

## Deploy su Render

1. Crea un account su [render.com](https://render.com)
2. Crea un nuovo **Web Service** → Connect GitHub repo
3. Settings:
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
4. Aggiungi le variabili d'ambiente:
   - `SESSION_SECRET` → stringa random
   - `DATA_DIR` → `/opt/render/project/data`
5. Aggiungi un **Disk** (nella sezione Advanced):
   - Mount Path: `/opt/render/project/data`
   - Size: 1 GB (sufficiente per molti assessment)

> **Nota**: Il piano free di Render va in sleep dopo inattività. Per uso continuativo, usa il piano Starter ($7/mese) o Railway.

## Flusso d'uso

### 1. Setup iniziale (una volta sola)
- Vai su `/vem/setup` e crea il primo account VEM admin
- Aggiungi altri utenti VEM da `/vem/users`

### 2. Pagina cliente
- Condividi l'URL della pagina principale (`/`) con i clienti
- Il cliente compila il questionario (34 domande, ~20-30 min)
- Al termine clicca **Invia al team VEM** — i dati vengono salvati sul server

### 3. Dashboard VEM
- Accedi a `/vem` con le tue credenziali
- Vedi tutti gli assessment ricevuti con data, stato e statistiche
- Clicca **Apri** per accedere al dettaglio

### 4. Analisi assessment
- **Tab "Review risposte"**: Vedi le risposte del cliente, aggiungi note tecniche VEM, fai override sulle risposte se necessario
- **"Genera finding"**: Genera automaticamente i finding in base alle risposte
- **Tab "Finding"**: Valida/modifica il rating, escludi finding falsi positivi, aggiungi finding manuali
- **Tab "Report finale"**: Report completo con Asset Inventory, Risk Matrix e Remediation Roadmap — pronto per la stampa o il salvataggio come PDF

### 5. Stato assessment
- **In attesa**: Assessment ricevuto, non ancora revisionato
- **In review**: Analisi in corso
- **Completato**: Report finale generato

## Sicurezza in produzione

- Imposta sempre `SESSION_SECRET` con una stringa random robusta (min 32 char)
- Usa HTTPS (Railway e Render lo gestiscono automaticamente)
- Se vuoi limitare l'accesso alla pagina cliente solo ai tuoi clienti, aggiungi autenticazione basic o un token nell'URL
- I dati sono salvati in file JSON locali — per maggiore robustezza in produzione considera di migrare a PostgreSQL (Railway offre PostgreSQL gratuito)

## Dipendenze

- `express` — web framework
- `express-session` — gestione sessioni
- `bcryptjs` — hashing password
- `uuid` — generazione ID univoci
