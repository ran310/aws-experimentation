# aws-experimentation

## `aws-infra`

AWS CDK (TypeScript) lives in [`aws-infra/`](aws-infra/) (that directory contains `cdk.json` and `package.json` for the app).

### Running CDK from the repository root

Install CDK app dependencies once:

```bash
cd aws-infra && npm install
```

Then you can run CDK from **either** place:

- **From `aws-infra/`:** `npx cdk synth`, `npx cdk deploy …`, etc. (`cdk.json` is here.)
- **From the repo root:** `npm run synth`, or **`npm run cdk -- <subcommand> [args…]`** (examples: `npm run cdk -- ls`, `npm run cdk -- deploy AwsInfra-HttpApi`). These delegate into `aws-infra/` so the app and `cdk.out` stay consistent.

**Do not run `npx cdk` from the repo root** — there is no `cdk.json` there, so you get `--app is required`. **Do not use `npm cdk`** (that is not an npm command). Use **`npx cdk`** only inside **`aws-infra/`**, or **`npm run cdk -- …`** from the root.

- **CDK infra:** [`aws-infra/README.md`](aws-infra/README.md)
- **Local dashboard (Python + React):** [`aws-infra-dashboard/README.md`](aws-infra-dashboard/README.md) — watches `aws-infra` and resynthesizes so the UI stays current.
