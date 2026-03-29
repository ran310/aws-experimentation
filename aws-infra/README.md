# aws-infra

TypeScript CDK app with **separate CloudFormation stacks** so you can deploy or destroy each stack independently. This folder is **infrastructure only** (no app UI here).

For a **local browser dashboard** (Python + React) that lists stacks, resources, and an architecture diagram—and **auto-resynthesizes** when you change CDK code—see [`../aws-infra-dashboard/README.md`](../aws-infra-dashboard/README.md).

**Clarification — HTTP API vs dashboard:** **`AwsInfra-HttpApi`** deploys **API Gateway + Lambda** that returns a **small JSON sample** (not a web UI). The **infra dashboard** is **not** served by that Lambda; it is a **separate** FastAPI + Vite app under **`aws-infra-dashboard/`** (run on your laptop, or install on the EC2 nginx host from **`AwsInfra-Ec2Nginx`**—see the dashboard README).

## Generated artifacts (after synth)

`npm run synth` runs **`cdk synth`** then **`bin/generate-infra-artifacts.mjs`**, which writes:

| File | Purpose |
|------|---------|
| `generated/stacks-overview.json` | Stack IDs, template descriptions, resource counts/types, outputs. |
| `generated/architecture.mmd` | Mermaid diagram of the same topology (for docs or the dashboard). |

See [`generated/README.md`](generated/README.md).

## Stacks

| Stack ID | Purpose |
|----------|---------|
| `AwsInfra-Network` | VPC (2 AZs), public + private subnets, **one NAT**. |
| `AwsInfra-Ec2Nginx` | **t4g.nano** (ARM, Amazon Linux 2023) with **nginx** path routing (`/app1/`, `/app2/`). **SSM Session Manager** (no SSH on 22). |
| `AwsInfra-RdsPostgres` | **PostgreSQL** in **private** subnets; credentials in **Secrets Manager**. Allows Postgres from the **EC2** security group on 5432. |
| `AwsInfra-ElastiCacheRedis` | Single-node **Redis** (`cache.t4g.micro`) in private subnets; allows Redis from the **EC2** security group on 6379. |
| `AwsInfra-HttpApi` | **HTTP API (API Gateway v2)** + **Lambda** (Node 20, no VPC) — **JSON sample API** only. The **dashboard UI** is **not** here; use **`aws-infra-dashboard`**. |

Layout: `lib/stacks/` for stacks, `lib/constructs/` for shared constructs you add later.

---

## Deploy (detailed commands)

**Where to run commands:** From **`aws-infra`**, or from the repo root use **`npm run synth`** / **`npm run cdk -- …`** (see [root README](../README.md)).

**`npx cdk`, not `npm cdk`:** Use **`npx cdk …`** here, or **`npm run cdk -- …`** from the parent repo.

### 0. Prerequisites

- **Node.js 20+** and npm
- **AWS CLI v2** configured
- IAM permissions for VPC, EC2, RDS, ElastiCache, Lambda, API Gateway, IAM, Secrets Manager, CloudFormation, etc.

### 1. Install

```bash
cd aws-infra
npm install
```

### 2. Account and region

```bash
export AWS_PROFILE=default
export CDK_DEFAULT_REGION=us-east-1
export CDK_DEFAULT_ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
```

### 3. Bootstrap (once per account + region)

```bash
npx cdk bootstrap aws://$CDK_DEFAULT_ACCOUNT/$CDK_DEFAULT_REGION
```

From repo root: `npm run bootstrap -- aws://$CDK_DEFAULT_ACCOUNT/$CDK_DEFAULT_REGION`

### 4. Synth (updates `cdk.out` + `generated/`)

```bash
npx cdk synth
npx cdk ls
```

### 5. Deploy

**Option A — everything (typical):**

```bash
npx cdk deploy --all
```

**Option B — explicit order:**

```bash
npx cdk deploy AwsInfra-Network
npx cdk deploy AwsInfra-Ec2Nginx
npx cdk deploy AwsInfra-RdsPostgres
npx cdk deploy AwsInfra-ElastiCacheRedis
npx cdk deploy AwsInfra-HttpApi
```

`AwsInfra-HttpApi` has **no VPC** dependency; you can deploy it alone for a quick serverless-only test. Stacks that use the VPC and **Ec2Nginx** security group need **Network** and **Ec2Nginx** deployed first.

### 6. HTTP API sample (Lambda JSON, not the dashboard)

After deploy, use stack output **HttpApiUrl** to call the **Lambda-backed JSON API** (e.g. `curl "$HttpApiUrl"`). For the **browser dashboard**, run or deploy **`aws-infra-dashboard`** separately.

### 7. Optional: `projectName`

```bash
npx cdk deploy -c projectName=my-sandbox AwsInfra-Network
```

---

## Destroy

```bash
npx cdk destroy --all
```

Or destroy stacks individually (often **HttpApi** / **RDS** / **Redis** / **EC2** before **Network**).

---

## Cost notes

NAT Gateway, RDS, ElastiCache, and EC2 are usually **not free tier**. Tear down when idle.

---

## Extending

- **New stack:** add under `lib/stacks/` and register in `bin/app.ts`; extend **`bin/generate-infra-artifacts.mjs`** if you want new nodes in `architecture.mmd`.
- **More nginx apps:** extend user data in `ec2-nginx-stack.ts`.
- **Lambda in VPC** talking to RDS/Redis: add a security group and allow it on the DB/cache stacks (pattern similar to the EC2 SG today).
