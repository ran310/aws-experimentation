/**
 * aws-cdk-lib bundles brace-expansion 5.0.3 (advisory GHSA-f886-m6hf-6m8v).
 * npm overrides do not apply to bundled deps. We hoist brace-expansion@5.0.5, copy it
 * into aws-cdk-lib's nested node_modules, and align package-lock.json so npm audit stays clean.
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const src = path.join(root, 'node_modules', 'brace-expansion');
const dest = path.join(root, 'node_modules', 'aws-cdk-lib', 'node_modules', 'brace-expansion');
const lockPath = path.join(root, 'package-lock.json');

function patchFilesystem() {
  if (!fs.existsSync(path.join(src, 'package.json'))) {
    return;
  }
  const destParent = path.dirname(dest);
  if (!fs.existsSync(destParent)) {
    return;
  }
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, { recursive: true });
}

function patchLockfile() {
  if (!fs.existsSync(lockPath)) {
    return;
  }
  let raw;
  try {
    raw = fs.readFileSync(lockPath, 'utf8');
  } catch {
    return;
  }
  const lock = JSON.parse(raw);
  const topKey = 'node_modules/brace-expansion';
  const nestedKey = 'node_modules/aws-cdk-lib/node_modules/brace-expansion';
  const top = lock.packages?.[topKey];
  const nested = lock.packages?.[nestedKey];
  if (!top?.version || !nested) {
    return;
  }
  if (nested.version === top.version && nested.resolved === top.resolved) {
    return;
  }
  nested.version = top.version;
  nested.resolved = top.resolved;
  nested.integrity = top.integrity;
  fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
}

function main() {
  patchFilesystem();
  patchLockfile();
}

main();
