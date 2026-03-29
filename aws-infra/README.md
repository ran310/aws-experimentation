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
| `AwsInfra-Ec2Nginx` | **t4g.nano** + **nginx** + optional **ACM + ALB + Route 53** (context `publicAlbHttps`) for **hands-off HTTPS**; otherwise **Elastic IP** + direct **:80/:443**. **SSM** (no SSH on 22). |
| `AwsInfra-ElastiCacheRedis` | Single-node **Redis** (`cache.t4g.micro`) in private subnets; allows Redis from the **EC2** security group on 6379. |
| `AwsInfra-HttpApi` | **HTTP API (API Gateway v2)** + **Lambda** (Node 20, no VPC) — **JSON sample API** only. The **dashboard UI** is **not** here; use **`aws-infra-dashboard`**. |
| `AwsInfra-Lakehouse-S3` | **S3** lake bucket (default name **`mylakehouse-{account}-{region}`**) + **IAM managed policies** for read-only vs read/write. Attach policies to any app role; organize data with **prefixes** (e.g. `raw/`, `curated/`). |

Layout: `lib/stacks/` for stacks, `lib/constructs/` for shared constructs you add later.

### Lakehouse bucket name (optional)

Override the default S3 name with context **`lakehouseBucketName`** (must be **globally unique**):

```json
"context": {
  "lakehouseBucketName": "mylakehouse-prod"
}
```

If omitted, the bucket is **`mylakehouse-<account-id>-<region>`** so it stays unique while keeping the **`mylakehouse`** prefix.

**Using policies:** After deploy, attach **`LakehouseReadOnlyPolicyArn`** or **`LakehouseReadWritePolicyArn`** (stack outputs) to Lambda roles, EC2 instance roles, ECS task roles, etc. **Prefix-scoped** permissions (different apps → different folders) can be added later with extra managed policies or `s3:prefix` conditions.

---

## Deploy (detailed commands)

**Where to run commands:** From **`aws-infra`**, or from the repo root use **`npm run synth`** / **`npm run cdk -- …`** (see [root README](../README.md)).

**`npx cdk`, not `npm cdk`:** Use **`npx cdk …`** here, or **`npm run cdk -- …`** from the parent repo.

### 0. Prerequisites

- **Node.js 20+** and npm
- **AWS CLI v2** configured
- IAM permissions for VPC, EC2, ElastiCache, Lambda, API Gateway, IAM, S3, CloudFormation, etc.
- If you use **managed HTTPS** (`publicAlbHttps`): **ACM**, **Elastic Load Balancing**, **Route 53** (records in the hosted zone).

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
npx cdk deploy AwsInfra-ElastiCacheRedis
npx cdk deploy AwsInfra-HttpApi
npx cdk deploy AwsInfra-Lakehouse-S3
```

`AwsInfra-HttpApi` and **`AwsInfra-Lakehouse-S3`** have **no VPC** dependency (deploy them anytime). Stacks that use the VPC and **Ec2Nginx** security group need **Network** and **Ec2Nginx** deployed first.

### 6. HTTP API sample (Lambda JSON, not the dashboard)

After deploy, use stack output **HttpApiUrl** to call the **Lambda-backed JSON API** (e.g. `curl "$HttpApiUrl"`). For the **browser dashboard**, run or deploy **`aws-infra-dashboard`** separately.

### 7. Optional: `projectName`

```bash
npx cdk deploy -c projectName=my-sandbox AwsInfra-Network
```

### 8. HTTPS (no manual EC2 login)

#### Option A — **Managed HTTPS (recommended): ACM + ALB + Route 53**

TLS terminates at an **internet-facing Application Load Balancer**. **ACM** issues the certificate using **DNS validation** (CDK creates the validation CNAMEs in your zone). **Route 53 A (alias)** records point your domain names at the ALB. The instance only serves **HTTP on :80** from the ALB; **no Certbot**, **no SSH/SSM** for certificates. Destroy/recreate the stack and, after DNS validation completes, HTTPS works again.

**Requirements**

- A **Route 53 public hosted zone** for your domain in the **same AWS account** you deploy into (so CDK can create validation and alias records).
- **Remove** any old **A** records that pointed the same names at an **Elastic IP** (otherwise you can have conflicting DNS). After deploy, names should **only** be the CDK-managed aliases to the ALB.

**Configuration**

Merge the keys from [`publicAlbHttps.context.json.example`](publicAlbHttps.context.json.example) into **`cdk.json`** → **`context`**, or pass JSON on the CLI (quotes as needed):

```bash
npx cdk deploy AwsInfra-Ec2Nginx -c 'publicAlbHttps={"hostedZoneId":"Z…","zoneName":"ram-narayanan.com","certificateDomainName":"ram-narayanan.com","subjectAlternativeNames":["www.ram-narayanan.com","nfl-quiz.ram-narayanan.com"]}'
```

| Field | Meaning |
|-------|--------|
| `hostedZoneId` | Route 53 hosted zone ID (e.g. `Z123…`). |
| `zoneName` | Zone apex, e.g. `ram-narayanan.com` (no trailing dot). |
| `certificateDomainName` | Primary ACM name (usually the apex). |
| `subjectAlternativeNames` | Optional list of extra names on the cert (www, subdomains). |
| `aliasNames` | Optional: explicit Route 53 **relative** labels (`""` = apex, `"www"`, `"nfl-quiz"`). If omitted, aliases are derived from the cert names. |

**Deploy**

```bash
npx cdk deploy AwsInfra-Ec2Nginx --require-approval never
```

First deploy can take several minutes while **ACM** validates. Outputs include **LoadBalancerDns**, **NginxHttpsBaseUrl**, and **NflQuizHttpsUrl**.

**Cost / tradeoff:** An **ALB** has its own hourly and LCU charges (on top of the **NAT** and **EC2** you already have). You gain **fully automated** TLS renewal via ACM and **no instance login**.

#### Option B — **Elastic IP + Certbot on the instance** (legacy)

If you **omit** `publicAlbHttps`, the stack keeps an **Elastic IP** and opens **:80** and **:443** to the internet so you can run **Let’s Encrypt / Certbot** on the box (see [`scripts/on-ec2-certbot-https.example.sh`](scripts/on-ec2-certbot-https.example.sh)). This avoids ALB cost but requires **manual** steps on the instance.

---

## Destroy

```bash
npx cdk destroy --all
```

Or destroy stacks individually (often **HttpApi** / **Lakehouse-S3** / **Redis** / **EC2** before **Network**). The lake bucket uses **RETAIN** so the bucket (and objects) remain after stack delete unless you empty it first.

---

## Cost notes

NAT Gateway, ElastiCache, and EC2 are usually **not free tier**. Tear down when idle.

---

## Extending

- **New stack:** add under `lib/stacks/` and register in `bin/app.ts`; extend **`bin/generate-infra-artifacts.mjs`** if you want new nodes in `architecture.mmd`.
- **More nginx apps:** extend user data in `ec2-nginx-stack.ts`.
- **Lambda in VPC** talking to Redis (or future RDS): add a security group and allow it on the cache/DB stack (pattern similar to the EC2 SG today).
