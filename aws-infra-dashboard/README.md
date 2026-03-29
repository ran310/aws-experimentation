# aws-infra-dashboard

**Python (FastAPI)** API plus **React (Vite)** UI that visualize whatever `aws-infra` last synthesized.

- **Stacks table** — reads `aws-infra/generated/stacks-overview.json` (resource counts, types, outputs). Stack IDs match the CDK app (`AwsInfra-Network`, `AwsInfra-Ec2Nginx`, `AwsInfra-RdsPostgres`, `AwsInfra-ElastiCacheRedis`, `AwsInfra-HttpApi`).
- **Architecture diagram** — renders `aws-infra/generated/architecture.mmd` (Mermaid).
- **Auto-refresh infra** — the backend **watches** `aws-infra/lib`, `aws-infra/bin`, and `aws-infra/cdk.json` and runs **`npm run synth`** (debounced ~1.5s after saves). The UI **polls** the API every 2.5s so you see updates without a manual reload.

## Prerequisites

- Node.js 20+ and `npm install` inside **`aws-infra`** (same as for CDK).
- Python 3.11+.

## Run locally

### Scripts (macOS / Linux)

From **`aws-infra-dashboard/`**:

```bash
chmod +x scripts/start.sh scripts/stop.sh
./scripts/start.sh
```

Opens the UI at **http://127.0.0.1:5173** (Vite proxies `/api` → **http://127.0.0.1:8000**). Logs under **`.dev/*.log`**. Stop with:

```bash
./scripts/stop.sh
```

### Manual (two terminals)

**Terminal 1 — API:**

```bash
cd aws-infra-dashboard/backend
python3 -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

**Terminal 2 — UI:**

```bash
cd aws-infra-dashboard/frontend
npm install
npm run dev
```

**Manual resynth** (optional): `curl -X POST http://127.0.0.1:8000/api/resynth`

## Run on EC2 (`AwsInfra-Ec2Nginx`)

The CDK stack only installs **nginx** + sample **`/app1/`** / **`/app2/`** paths; it does **not** deploy this dashboard. To serve the dashboard on the same instance (**HTTP on port 80** is already open in the security group):

1. **Connect** with **SSM Session Manager** (instance role already has `AmazonSSMManagedInstanceCore`).
2. **Clone** this repo (or copy `aws-infra` + `aws-infra-dashboard` next to each other, same layout as on your laptop). Example: `/opt/aws-experimentation/`.
3. **Install tooling** on Amazon Linux 2023 **ARM** (t4g): `dnf install -y python3.11 python3.11-pip git` and Node.js 20 ([NodeSource](https://github.com/nodesource/distributions) or `fnm`/`nvm`).
4. **Install & synth CDK app** (needs Node for `npm run synth`):

   ```bash
   cd /opt/aws-experimentation/aws-infra && npm ci && npm run synth
   ```

5. **Backend:** `cd aws-infra-dashboard/backend && python3.11 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt`
6. **Frontend:** `cd aws-infra-dashboard/frontend && npm ci && npm run build` (produces **`dist/`**; the UI calls **`/api/...`** on the same origin).
7. **Run API** under **systemd** so it survives logout — copy and edit [`systemd/aws-infra-dashboard.service.example`](systemd/aws-infra-dashboard.service.example), then `sudo systemctl enable --now aws-infra-dashboard`.
8. **nginx:** The stock EC2 user-data config uses **`default_server`** on port 80. Either **disable** `/etc/nginx/conf.d/<projectName>-apps.conf` and use [`nginx/dashboard.conf.example`](nginx/dashboard.conf.example), **or** merge **`location /api/`** and a **`root`**/`**try_files**` SPA block into that file. Set **`root`** to your **`frontend/dist`** path. `sudo nginx -t && sudo systemctl reload nginx`.
9. Open **`http://<NginxPublicIp>/`** (stack output **NginxPublicIp**).

**Note:** `cdk synth` on a **t4g.nano** is tight on CPU/RAM; you can run **`npm run synth`** on your laptop and **rsync** `aws-infra/generated/` to the instance if you prefer.

**Note:** If your CDK code uses **`fromLookup`**, synth on EC2 needs AWS credentials (instance profile). A template-only synth usually does not.

## How it stays in sync

1. You edit CDK code under `aws-infra/`.
2. `watchfiles` triggers `npm run synth` in `aws-infra` → `cdk synth` + `generate-infra-artifacts.mjs` refresh `generated/`.
3. The React app refetches `/api/overview` and `/api/architecture.mmd` on a short interval.

If the API is not running, run `cd aws-infra && npm run synth` once so `generated/` exists.
