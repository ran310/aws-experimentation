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

The **`generated/`** directory is **gitignored**; run `npm run synth` locally (or in CI) to create these files after clone.

## Deployed stack outputs (AWS CLI)

After stacks exist in your account, you can snapshot **live** CloudFormation outputs (not template defaults) into **`cdk.out/`**, which is **gitignored** and not committed:

```bash
cd aws-infra
npm run outputs:fetch
```

This runs **`aws cloudformation describe-stacks`** for each stack ID in `bin/app.ts` and writes:

| File | Purpose |
|------|---------|
| `cdk.out/stack-outputs-deployed.md` | Markdown tables (OutputKey, Description, OutputValue, ExportName). |
| `cdk.out/stack-outputs-deployed.json` | Same data as JSON for scripts. |

Use the same **AWS CLI profile/region** as deploy (`AWS_PROFILE`, `AWS_REGION`, or `~/.aws/config`). Missing stacks or permission errors are recorded per stack in the files instead of failing the whole run.

## Stacks

| Stack ID | Purpose |
|----------|---------|
| `AwsInfra-Network` | VPC (2 AZs), public + private subnets, **one NAT**. |
| `AwsInfra-Ec2Nginx` | **t4g.large** (**8 GiB** RAM by default; `EC2_NGINX_INSTANCE_SIZE` in `ec2-nginx-stack.ts`) + **nginx** + optional **ACM + ALB + Route 53** (context `publicAlbHttps`). **Which apps**, paths, ports, CodeDeploy groups, and optional user-data **systemd** are declared in **`lib/config/ec2-nginx-apps.ts`** (not hardcoded in the stack). Root EBS **30 GiB gp3**. |
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

### Enlarge root disk without replacing the instance (console)

If the stack was created before the **30 GiB** root volume default, or you need more space **without** `cdk deploy` replacing the EC2 instance:

1. **EC2 → Volumes** → select the volume attached to the nginx instance (**/dev/xvda**).
2. **Actions → Modify volume** → set size (e.g. **30** or **40** GiB) → **Modify**.
3. **SSM Session Manager** (or SSM Run command) on the instance:

   ```bash
   sudo growpart /dev/nvme0n1 1   # if root is NVMe; use lsblk to confirm device
   sudo xfs_growfs -d /           # Amazon Linux 2023 root is usually XFS
   ```

   On some instances the block device is **`/dev/xvda`** and the partition may be **`/dev/xvda1`** — use **`lsblk`** and **`df -h`** to confirm, then **`growpart`** the correct disk and partition number, then **`xfs_growfs /`**.

4. Verify with **`df -h /`**.

Changing **`blockDevices`** in CDK and redeploying may trigger **instance replacement**; use the console path above to grow disk **in place** on an existing host.

### 6. Redeploying applications on EC2 replacement

If the EC2 instance gets replaced or recreated (which happens when you change certain properties in `AwsInfra-Ec2Nginx`), the brand new instance will boot up without any of your CodeDeploy applications. Only the apps with direct `userDataBootstrap` will run on boot.

To quickly deploy all registered applications to the new instance via GitHub Actions, run:

```bash
./scripts/sync-github-aws-role-secret.sh --from-ec2-nginx-apps --skip-secrets --run-deploy-workflow
```

This script will read the list of repositories from the CDK configuration and dispatch the "Deploy to AWS" workflow for each repository.

### 7. HTTP API sample (Lambda JSON, not the dashboard)

After deploy, use stack output **HttpApiUrl** to call the **Lambda-backed JSON API** (e.g. `curl "$HttpApiUrl"`). For the **browser dashboard**, run or deploy **`aws-infra-dashboard`** separately.

### 8. Optional: `projectName`

```bash
npx cdk deploy -c projectName=my-sandbox AwsInfra-Network
```

### 9. HTTPS (no manual EC2 login)

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

## Adding a New Application

To add and host a new application behind the nginx host with automated deployment via GitHub Actions, follow these steps:

### 1. Register the application in the CDK configuration

Add a new application definition object to the `EC2_NGINX_APPS` array in [ec2-nginx-apps.ts](file:///Users/ram/Documents/code/github/aws-experimentation/aws-infra/lib/config/ec2-nginx-apps.ts).

Here is a template structure with all supported options:

```typescript
{
  // Unique stable identifier (kebab-case). Drives S3 prefixes, CodeDeploy deployment group name suffixes, and CDK output keys.
  id: 'my-awesome-app',

  // The GitHub repository path (owner/repo). Used for OIDC role access scoping.
  repoName: 'ran310/my-awesome-app',

  // S3 folder prefix under the artifact bucket where CodeDeploy release bundles are uploaded.
  s3ArtifactPrefix: 'my-awesome-app',

  // Public URL path prefix. e.g. /my-awesome-app. Must start with '/' and must not end with '/'.
  // Use "" only if this is the default root site (proxied as location /).
  pathPrefix: '/my-awesome-app',

  // Local upstream port the application process listens on (must be unique).
  upstreamPort: 8087,

  // Register a dedicated CodeDeploy deployment group + stack output.
  codeDeploy: true,

  // (Optional) If set, user-data automatically creates target directory, env file, and systemd unit (first-boot only).
  userDataBootstrap: {
    optDir: '/opt/my-awesome-app',
    systemdServiceName: 'my-awesome-app',
    systemdDescription: 'My Awesome App (Gunicorn)',
    conditionPathExists: '/opt/my-awesome-app/venv/bin/gunicorn',
    workingDirectory: '/opt/my-awesome-app/app',
    environmentFile: '/etc/my-awesome-app.env',
    execStart: '/opt/my-awesome-app/venv/bin/gunicorn --bind 127.0.0.1:__PORT__ app:app', // __PORT__ and __PATH_PREFIX__ are auto-substituted
    extraEnvLines: [ // (Optional) Additional lines appended to the environment file
      'FLASK_DEBUG=1'
    ]
  },

  // (Optional) For inserting custom nginx location blocks before proxy routing
  // nginxExtraLocations: [ ... ],

  // (Optional) Apply HTTP Basic Auth
  // nginxBasicAuth: { realm: 'App Realm', userFile: '/etc/nginx/.htpasswd' },

  // (Optional) Run custom shell scripts on the EC2 instance post-deployment setup
  // userDataExtra: ['mkdir -p /var/lib/my-awesome-app']
}
```

### 2. Synthesize and redeploy the infra

Save the configuration and deploy the updated EC2 Nginx and GitHub OIDC stacks:

```bash
cd aws-infra
npm run synth
npx cdk deploy AwsInfra-Ec2Nginx AwsInfra-GitHubOidc
```

Deploying updates the EC2 instance's Nginx configuration via SSM, provisions the CodeDeploy Deployment Group (`<projectName>-ec2-nginx-dg-my-awesome-app`), and configures the OIDC IAM role trust policy to allow your new GitHub repository to assume it.

### 3. Configure the Application GitHub Repository

To enable automated deployment on push, configure your application repository with the following:

#### A. Set up the OIDC Role Secret
1. Fetch the value of the `GitHubActionsRoleArn` output from the `AwsInfra-GitHubOidc` stack.
2. In your application's GitHub repository settings, go to **Settings -> Secrets and variables -> Actions** and create a repository secret named **`AWS_ROLE_TO_ASSUME`** containing that ARN.
3. *Alternative:* You can automate secret synchronization across your app repos using the helper script:
   ```bash
   ./scripts/sync-github-aws-role-secret.sh --from-ec2-nginx-apps
   ```

#### B. Create `appspec.yml`
Create an `appspec.yml` file at the root of the application repository to define how CodeDeploy installs and restarts your application:

```yaml
version: 0.0
os: linux
files:
  - source: /
    destination: /opt/my-awesome-app/app
permissions:
  - object: /opt/my-awesome-app
    owner: ec2-user
    group: ec2-user
    mode: 755
    type:
      - directory
      - file
hooks:
  BeforeInstall:
    - location: scripts/before-install.sh
      timeout: 300
      runas: root
  AfterInstall:
    - location: scripts/after-install.sh
      timeout: 300
      runas: root
  ApplicationStart:
    - location: scripts/application-start.sh
      timeout: 120
      runas: root
```

*Typical hook script implementations:*
- **`scripts/before-install.sh`**: Stop the active service to free files (e.g. `systemctl stop my-awesome-app || true`).
- **`scripts/after-install.sh`**: Set up a virtual environment (e.g., Python venv), run `pip install -r requirements.txt`, create logs folders, and ensure permissions match.
- **`scripts/application-start.sh`**: Reload systemd configurations and restart the application service:
  ```bash
  #!/bin/bash
  systemctl daemon-reload
  systemctl restart my-awesome-app
  ```

#### C. Create a Deployment Workflow
Create a `.github/workflows/deploy.yml` file in your application repository:

```yaml
name: Deploy to AWS

on:
  push:
    branches:
      - main
  workflow_dispatch:

permissions:
  id-token: write
  contents: read

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout Code
        uses: actions/checkout@v4

      # (Optional) Add build/test steps here, e.g., setting up Node or Python

      - name: Configure AWS Credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ secrets.AWS_ROLE_TO_ASSUME }}
          aws-region: us-east-1 # Change to match your AWS deployment region

      - name: Deploy to AWS CodeDeploy
        run: |
          # Fetch the artifact bucket name dynamically from the SSM parameter
          PROJECT_NAME="learn-aws" # Must match context/projectName in cdk.json (default: 'learn-aws')
          
          BUCKET_NAME=$(aws ssm get-parameter --name "/$PROJECT_NAME/ec2-nginx/artifact-bucket-name" --query "Parameter.Value" --output text)
          APP_NAME="${PROJECT_NAME}-ec2-nginx-apps"
          DG_NAME="${PROJECT_NAME}-ec2-nginx-dg-my-awesome-app" # Suffix matches your app.id

          # Package files and upload to S3
          aws deploy push \
            --application-name "$APP_NAME" \
            --s3-location "s3://$BUCKET_NAME/my-awesome-app/releases/bundle.zip" \
            --source .

          # Create deployment
          aws deploy create-deployment \
            --application-name "$APP_NAME" \
            --deployment-group-name "$DG_NAME" \
            --s3-location "bucket=$BUCKET_NAME,key=my-awesome-app/releases/bundle.zip,bundleType=zip" \
            --file-exists-behavior OVERWRITE
```

---

## Cost notes

NAT Gateway, ElastiCache, and EC2 are usually **not free tier**. Tear down when idle.

---

## Extending

- **New stack:** add under `lib/stacks/` and register in `bin/app.ts`; extend **`bin/generate-infra-artifacts.mjs`** if you want new nodes in `architecture.mmd`.
- **More nginx apps:** register a new service. See the step-by-step instructions in [Adding a New Application](#adding-a-new-application) above.
- **Lambda in VPC** talking to Redis (or future RDS): add a security group and allow it on the cache/DB stack (pattern similar to the EC2 SG today).
