# Deployment Guide

How to get RAT live on the internet with a permanent URL.

---

## Option A: Railway (Easiest -- recommended)

Railway auto-detects Node.js, builds from your Dockerfile, and provides a persistent volume for SQLite + repo data.

### Steps

1. **Push this repo to GitHub** (if not already):
   ```bash
   git add .
   git commit -m "Add Docker deployment files"
   git push
   ```

2. **Go to [railway.app](https://railway.app)** and sign in with GitHub.

3. **Click "New Project" > "Deploy from GitHub repo"** and select this repository.

4. **Add a volume** (critical -- without this, data is lost on restart):
   - In your service settings, go to the **"Volumes"** tab.
   - Click **"Add Volume"**.
   - Set the mount path to `/app/data`.

5. **Set environment variables** (in the "Variables" tab):
   | Variable | Value |
   |---|---|
   | `RAT_HOST` | `0.0.0.0` |
   | `RAT_PORT` | `8787` |
   | `RAT_DATA_DIR` | `/app/data` |

6. **Generate a public URL**:
   - Go to **"Settings" > "Networking" > "Generate Domain"**.
   - You get a URL like `https://rat-xxxx.up.railway.app`.

7. **Open the URL** -- done.

### Cost
Railway gives $5 of free credit monthly. RAT is lightweight, so it should stay within the free tier for personal/demo use.

---

## Option B: Render

Render also supports persistent disks and Docker deploys.

### Steps

1. **Push to GitHub**.

2. **Go to [render.com](https://render.com)** and sign in.

3. **New > Web Service > connect your repo**.

4. Configure:
   - **Build Command**: `docker build -t rat .` (or use "Native Runtime" with `npm install && npm run build`)
   - **Start Command**: `npm start`
   - **Environment Variables**: same as Railway above.

5. **Add a persistent disk**:
   - In settings, add a disk with mount path `/app/data`.
   - Start with 1 GB (enough for dozens of repos).

6. Deploy. You get a URL like `https://rat-xxxx.onrender.com`.

### Cost
Render has a free tier (spins down after inactivity). The persistent disk costs ~$1/month for 1 GB.

---

## Option C: Any VPS with Docker (Hetzner, DigitalOcean, etc.)

Full control, works with any Linux server.

### Prerequisites
- A VPS running Linux (Ubuntu 22.04+ recommended)
- Docker and Docker Compose installed
- A domain name (optional, but nice)

### Steps

1. **SSH into your VPS** and clone the repo:
   ```bash
   git clone https://github.com/YOUR_USERNAME/RepoAnalysisTool.git
   cd RepoAnalysisTool
   ```

2. **Start with Docker Compose**:
   ```bash
   docker compose up -d
   ```
   This builds the image, starts the server, and creates a persistent volume for data.

3. **Verify it is running**:
   ```bash
   curl http://localhost:8787/api/health
   ```

4. **(Optional) Add a reverse proxy with HTTPS**:
   Install Caddy for automatic TLS:
   ```bash
   apt install -y caddy
   ```
   Create `/etc/caddy/Caddyfile`:
   ```
   rat.yourdomain.com {
       reverse_proxy localhost:8787
   }
   ```
   ```bash
   systemctl restart caddy
   ```

5. **(Optional) Open the firewall**:
   ```bash
   ufw allow 80
   ufw allow 443
   ```

### Cost
- Hetzner CX11: ~4 EUR/month
- DigitalOcean Basic: ~$4/month

---

## What changed in the code

Two small changes were made to support cloud deployment:

1. **`src/server/config.ts`** -- Added `HOST` config (`RAT_HOST` env var, defaults to `0.0.0.0` instead of only `127.0.0.1`).
2. **`src/server/index.ts`** -- Server now binds to the `HOST` value so Docker/cloud networking can reach it.

No other code changes are needed. The Dockerfile, `.dockerignore`, and `docker-compose.yml` are new files that enable containerized deployment.

---

## After deployment

Once live, you can:
- Clone public repos by URL directly from the UI
- Upload `.zip` files containing `.git` directories
- All data persists in the Docker volume across restarts
- Share the URL with anyone
