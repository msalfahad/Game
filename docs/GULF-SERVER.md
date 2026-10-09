# Run the game server in the Gulf (lowest lag from Kuwait)

Ping is distance. Render's closest region (Frankfurt) is ~90-110 ms from Kuwait;
a server in the Gulf is roughly 20-40 ms. This guide puts the **whole game**
(client + multiplayer server) on one small VM with automatic HTTPS.

> Prices, free tiers and region availability change — check the provider's
> page before you commit. Nothing here needs more than 1 vCPU / 1-2 GB RAM.

## 1. Pick a VM region

| Provider | Gulf region | Region id |
|---|---|---|
| Google Cloud | Doha, Qatar | `me-central1` |
| Google Cloud | Dammam, Saudi Arabia | `me-central2` |
| AWS | Bahrain (opt-in region) | `me-south-1` |
| AWS | UAE | `me-central-1` |
| Azure | UAE North | `uaenorth` |
| Oracle Cloud | Dubai / Jeddah (has an Always-Free tier; capacity varies) | `me-dubai-1` / `me-jeddah-1` |

Any of them works — choose by price and what your account already has. Pick
**Ubuntu 22.04/24.04**, 1-2 GB RAM, and allow inbound **TCP 80 and 443** (plus 22 for SSH).

Google Cloud example:

```bash
gcloud compute instances create bash-arena \
  --zone=me-central1-a --machine-type=e2-small \
  --image-family=ubuntu-2204-lts --image-project=ubuntu-os-cloud \
  --tags=http-server,https-server
gcloud compute firewall-rules create allow-web --allow=tcp:80,tcp:443 \
  --target-tags=http-server,https-server
```

## 2. Get a domain name pointing at the VM

HTTPS needs a name. Free option: make one at https://www.duckdns.org (e.g.
`basharena.duckdns.org`) and set its IP to the VM's public IP. Any domain you
own works too (add an A record).

## 3. Install and start

SSH into the VM, then:

```bash
curl -fsSL https://get.docker.com | sudo sh
git clone https://github.com/msalfahad/Game.git && cd Game
git checkout claude/awaiting-info-wfsny5     # or main once merged
DOMAIN=basharena.duckdns.org sudo -E docker compose up -d --build
```

Caddy fetches a free HTTPS certificate on first start (takes ~30 s). Then open
`https://basharena.duckdns.org` — that URL is the full game and plays online
with zero setup. Accounts and XP persist in a Docker volume across restarts and
updates.

Update later with: `git pull && DOMAIN=... sudo -E docker compose up -d --build`.

## 4. Make the GitHub Pages site use it too (optional)

In the GitHub repo: **Settings → Secrets and variables → Actions → Variables →
New repository variable**: name `GAME_SERVER_URL`, value
`https://basharena.duckdns.org`. The next deploy bakes it in, so
msalfahad.github.io/Game connects to the Gulf server by default (players
with an old saved server are moved over automatically).

## 5. Check it's healthy

- `https://<your-domain>/healthz` should answer `{"ok":true}`.
- In-game, the PLAY ONLINE button should connect in a second or two (no
  "waking the server" wait — a VM never sleeps like Render's free tier).
- Logs: `sudo docker compose logs -f game`.

## Why not just stay on Render?

Render stays a fine fallback (`render.yaml`, Frankfurt). Its free plan also
sleeps after 15 idle minutes (~1 min to wake) and shares CPU; a small always-on
VM in the Gulf fixes both and is the biggest single lag improvement available.
