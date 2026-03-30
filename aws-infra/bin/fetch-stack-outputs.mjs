#!/usr/bin/env node
/**
 * Runs `aws cloudformation describe-stacks` for each app stack and writes
 * markdown + JSON under cdk.out/ (gitignored).
 *
 * Keep STACK_NAMES in sync with bin/app.ts stack IDs.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CDK_OUT = join(__dirname, '..', 'cdk.out');

/** @type {string[]} */
const STACK_NAMES = [
  'AwsInfra-Network',
  'AwsInfra-Ec2Nginx',
  'AwsInfra-ElastiCacheRedis',
  'AwsInfra-HttpApi',
  'AwsInfra-Lakehouse-S3',
];

/**
 * @param {string} stackName
 * @returns {{ ok: true, outputs: object[] } | { ok: false, error: string }}
 */
function describeStack(stackName) {
  try {
    const out = execFileSync(
      'aws',
      ['cloudformation', 'describe-stacks', '--stack-name', stackName, '--output', 'json'],
      { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }
    );
    const parsed = JSON.parse(out);
    const stack = parsed.Stacks?.[0];
    return { ok: true, outputs: stack?.Outputs ?? [] };
  } catch (e) {
    const stderr =
      typeof e.stderr === 'string'
        ? e.stderr
        : e.stderr != null && Buffer.isBuffer(e.stderr)
          ? e.stderr.toString('utf8')
          : '';
    const msg = stderr.trim() || (e instanceof Error ? e.message : String(e));
    return { ok: false, error: msg };
  }
}

/** @param {unknown} s */
function mdCell(s) {
  if (s == null || s === '') return '';
  return String(s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/**
 * @param {{ stackName: string; ok: boolean; outputs?: object[]; error?: string }[]} rows
 */
function buildMarkdown(rows) {
  const lines = [
    '# Deployed stack outputs (CloudFormation)',
    '',
    `Generated \`${new Date().toISOString()}\` via \`aws cloudformation describe-stacks\`.`,
    '',
    'These files are under **`cdk.out/`** (gitignored). Treat values as operational detail; avoid publishing if your threat model treats ARNs/URLs as sensitive.',
    '',
  ];
  for (const r of rows) {
    lines.push(`## ${r.stackName}`, '');
    if (!r.ok) {
      lines.push(`*Stack not found or describe failed:* \`${mdCell(r.error)}\``, '');
      continue;
    }
    const outputs = r.outputs ?? [];
    if (!outputs.length) {
      lines.push('*No outputs.*', '');
      continue;
    }
    lines.push('| OutputKey | Description | OutputValue | ExportName |');
    lines.push('|-----------|-------------|-------------|------------|');
    for (const o of outputs) {
      lines.push(
        `| ${mdCell(o.OutputKey)} | ${mdCell(o.Description)} | ${mdCell(o.OutputValue)} | ${mdCell(o.ExportName)} |`
      );
    }
    lines.push('');
  }
  return lines.join('\n');
}

mkdirSync(CDK_OUT, { recursive: true });

const rows = STACK_NAMES.map((stackName) => {
  const r = describeStack(stackName);
  return r.ok ? { stackName, ok: true, outputs: r.outputs } : { stackName, ok: false, error: r.error };
});

const mdPath = join(CDK_OUT, 'stack-outputs-deployed.md');
const jsonPath = join(CDK_OUT, 'stack-outputs-deployed.json');

writeFileSync(mdPath, buildMarkdown(rows), 'utf8');
writeFileSync(
  jsonPath,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      stacks: Object.fromEntries(
        rows.map((r) => [
          r.stackName,
          r.ok ? r.outputs : { error: r.error },
        ])
      ),
    },
    null,
    2
  ),
  'utf8'
);

console.log(`Wrote ${mdPath}`);
console.log(`Wrote ${jsonPath}`);
