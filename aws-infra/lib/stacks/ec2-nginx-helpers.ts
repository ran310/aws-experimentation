import { Buffer } from 'node:buffer';
import type { Ec2NginxAppDefinition } from '../config/ec2-nginx-apps';
import { EC2_NGINX_GLOBAL_LOCATION_SNIPPETS } from '../config/ec2-nginx-apps';

function expandAppTemplate(s: string, port: number, pathPrefix: string): string {
  return s.replace(/__PORT__/g, String(port)).replace(/__PATH_PREFIX__/g, pathPrefix);
}

const PROXY_COMMON = [
  '        proxy_http_version 1.1;',
  '        proxy_set_header Host $host;',
  '        proxy_set_header X-Real-IP $remote_addr;',
  '        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;',
  '        proxy_set_header X-Forwarded-Proto $scheme;',
] as const;

function nginxProxyLocation(pathPrefix: string, port: number): string[] {
  const p = pathPrefix;
  return [
    `    location = ${p} {`,
    `        return 301 ${p}/;`,
    '    }',
    '',
    `    location ${p}/ {`,
    `        proxy_pass http://127.0.0.1:${port}/;`,
    ...PROXY_COMMON,
    `        proxy_set_header X-Forwarded-Prefix ${p};`,
    '    }',
    '',
  ];
}

function nginxRootLocation(port: number): string[] {
  return [
    '    location / {',
    `        proxy_pass http://127.0.0.1:${port}/;`,
    ...PROXY_COMMON,
    '        proxy_set_header X-Forwarded-Prefix "";',
    '    }',
    '}',
  ];
}

/**
 * Full `server { … }` block for conf.d (ALB → :80).
 */
export function renderNginxServerBlock(apps: Ec2NginxAppDefinition[]): string {
  const root = apps.find((a) => a.pathPrefix === '');
  if (!root) {
    throw new Error('renderNginxServerBlock: missing root app');
  }

  const lines: string[] = [
    'server {',
    '    listen 80 default_server;',
    '    listen [::]:80 default_server;',
    '    server_name _;',
    '',
    '    location = /nginx-health {',
    '        access_log off;',
    '        default_type text/plain;',
    "        return 200 'ok';",
    '    }',
    '',
  ];

  const prefixed = apps
    .filter((a) => a.pathPrefix !== '')
    .sort((a, b) => {
      const d = b.pathPrefix.length - a.pathPrefix.length;
      return d !== 0 ? d : a.pathPrefix.localeCompare(b.pathPrefix);
    });

  for (const a of prefixed) {
    for (const extra of a.nginxExtraLocations ?? []) {
      lines.push(extra);
    }
    lines.push(...nginxProxyLocation(a.pathPrefix, a.upstreamPort));
  }

  lines.push(EC2_NGINX_GLOBAL_LOCATION_SNIPPETS);
  lines.push('');

  for (const extra of root.nginxExtraLocations ?? []) {
    lines.push(extra);
    lines.push('');
  }

  lines.push(...nginxRootLocation(root.upstreamPort));

  return lines.join('\n');
}

export function renderSystemdUnit(app: Ec2NginxAppDefinition): string {
  const b = app.userDataBootstrap;
  if (!b) {
    throw new Error(`renderSystemdUnit: app ${app.id} has no userDataBootstrap`);
  }
  const port = app.upstreamPort;
  const pfx = app.pathPrefix;
  const execStart = expandAppTemplate(b.execStart, port, pfx);
  const restartSec = b.restartSec ?? '5';

  return [
    '[Unit]',
    `Description=${b.systemdDescription}`,
    'After=network.target',
    `ConditionPathExists=${b.conditionPathExists}`,
    '',
    '[Service]',
    'Type=simple',
    'User=root',
    `WorkingDirectory=${b.workingDirectory}`,
    `EnvironmentFile=${b.environmentFile}`,
    `ExecStart=${execStart}`,
    'Restart=on-failure',
    `RestartSec=${restartSec}`,
    '',
    '[Install]',
    'WantedBy=multi-user.target',
  ].join('\n');
}

/**
 * Shell lines to run during EC2 user-data for one app (mkdir, env, systemd unit).
 */
export function userDataCommandsForAppBootstrap(app: Ec2NginxAppDefinition): string[] {
  const b = app.userDataBootstrap;
  if (!b) {
    return [];
  }
  const unit = renderSystemdUnit(app);
  const unitB64 = Buffer.from(unit, 'utf8').toString('base64');
  const port = app.upstreamPort;
  const pfx = app.pathPrefix;
  const root = pfx === '' ? '/' : pfx;
  const envLines = [`APPLICATION_ROOT=${root}`];
  for (const row of b.extraEnvLines ?? []) {
    envLines.push(expandAppTemplate(row, port, pfx));
  }
  const printfArgs = envLines.map((l) => bashSingleQuoted(l)).join(' ');
  return [
    `mkdir -p ${b.optDir}/app`,
    `printf '%s\\n' ${printfArgs} > ${b.environmentFile}`,
    `printf '%s' '${unitB64}' | base64 -d > /etc/systemd/system/${b.systemdServiceName}.service`,
  ];
}

function bashSingleQuoted(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function staticDemoHtmlUserData(): string[] {
  return [
    'mkdir -p /var/www/app1 /var/www/app2',
    'echo "<h1>App 1</h1><p>Path: /app1</p>" > /var/www/app1/index.html',
    'echo "<h1>App 2</h1><p>Path: /app2</p>" > /var/www/app2/index.html',
  ];
}