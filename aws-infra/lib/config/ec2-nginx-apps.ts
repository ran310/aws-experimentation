/**
 * Single source of truth for apps behind the EC2 nginx host.
 * Add a row here to register S3 prefix, upstream port, CodeDeploy DG, optional user-data bootstrap, etc.
 */
import * as iam from 'aws-cdk-lib/aws-iam';

/** Convert kebab-id to PascalCase for CloudFormation OutputKey suffixes (matches GitHub Actions queries). */
export function nginxAppIdToPascal(id: string): string {
  return id
    .split(/-+/)
    .filter(Boolean)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase())
    .join('');
}

export interface Ec2NginxAppUserDataBootstrap {
  /** e.g. /opt/nfl-quiz */
  readonly optDir: string;
  /** systemd unit filename without path (e.g. nfl-quiz). */
  readonly systemdServiceName: string;
  readonly systemdDescription: string;
  /** ConditionPathExists=… for [Unit] (full path to gunicorn binary). */
  readonly conditionPathExists: string;
  readonly workingDirectory: string;
  readonly environmentFile: string;
  /**
   * Lines appended after optional APPLICATION_ROOT line.
   * Placeholders: __PORT__ → upstream port, __PATH_PREFIX__ → pathPrefix (no trailing slash).
   */
  readonly extraEnvLines?: string[];
  /**
   * Gunicorn (or other) ExecStart. Placeholders: __PORT__, __PATH_PREFIX__.
   */
  readonly execStart: string;
  readonly restartSec?: string;
}

export interface Ec2NginxAppDefinition {
  /**
   * Stable id (kebab-case). Drives S3 prefix, deployment group suffix, construct ids.
   */
  readonly id: string;
  /**
   * GitHub repository as `owner/repo` (optional). For docs and tooling; CDK stacks do not read this.
   */
  readonly repoName: string;
  /** S3 folder for CodeDeploy bundles: `{s3ArtifactPrefix}/releases/…`. */
  readonly s3ArtifactPrefix: string;
  /**
   * Public URL path. Use "" for the default site (proxied as `location /`).
   * Non-empty must start with `/` and must not end with `/`.
   */
  readonly pathPrefix: string;
  readonly upstreamPort: number;
  /** Register a dedicated CodeDeploy deployment group + stack output. */
  readonly codeDeploy: boolean;
  /** If set, user-data creates opt dir, env file, and systemd unit (first-boot only). */
  readonly userDataBootstrap?: Ec2NginxAppUserDataBootstrap;
  /**
   * Extra nginx `location` blocks (full lines, indented), inserted before `location /`.
   * Use for legacy redirects, static aliases, etc.
   */
  readonly nginxExtraLocations?: string[];
  /** Attach the shared read-only IAM policy used by the AWS health dashboard (boto3). */
  readonly attachHealthDashboardInstancePolicy?: boolean;
  /**
   * Override CDK construct id for the HTTPS URL output (ALB mode). Default: `HttpsUrl{Pascal(id)}`.
   * Set to keep stable output names when renaming `id` (e.g. `NflQuizHttpsUrl`).
   */
  readonly httpsUrlOutputConstructId?: string;
  /**
   * Override CDK construct id for the HTTP URL output (EIP mode). Default: `HttpUrl{Pascal(id)}`.
   */
  readonly httpUrlOutputConstructId?: string;
}

const healthDashboardReadOnlyPolicy = new iam.PolicyStatement({
  sid: 'HealthDashboardReadOnly',
  actions: [
    'cloudformation:ListStacks',
    'cloudformation:DescribeStacks',
    'cloudwatch:GetMetricStatistics',
    'cloudwatch:ListMetrics',
    'ec2:DescribeInstances',
    'ec2:DescribeInstanceStatus',
    'lambda:ListFunctions',
    'elasticache:DescribeCacheClusters',
    'apigateway:GET',
    's3:ListAllMyBuckets',
    's3:GetBucketLocation',
    'health:DescribeEvents',
    'health:DescribeEventDetails',
    'health:DescribeAffectedEntities',
  ],
  resources: ['*'],
});

/**
 * Default apps for this sandbox. Edit this list to add or remove services.
 */
export const EC2_NGINX_APPS: Ec2NginxAppDefinition[] = [
  {
    id: 'project-showcase',
    repoName: 'ran310/project-showcase',
    s3ArtifactPrefix: 'project-showcase',
    pathPrefix: '',
    upstreamPort: 8081,
    codeDeploy: true,
    nginxExtraLocations: [
      '    location = /project-showcase {',
      '        return 301 /;',
      '    }',
      '    location /project-showcase/ {',
      '        rewrite ^/project-showcase/(.*)$ /$1 permanent;',
      '    }',
    ],
  },
  {
    id: 'nfl-quiz',
    repoName: 'ran310/nfl-quiz',
    s3ArtifactPrefix: 'nfl-quiz',
    pathPrefix: '/nfl-quiz',
    upstreamPort: 8080,
    codeDeploy: true,
    httpsUrlOutputConstructId: 'NflQuizHttpsUrl',
    httpUrlOutputConstructId: 'NflQuizUrl',
    userDataBootstrap: {
      optDir: '/opt/nfl-quiz',
      systemdServiceName: 'nfl-quiz',
      systemdDescription: 'NFL Quiz (Gunicorn)',
      conditionPathExists: '/opt/nfl-quiz/venv/bin/gunicorn',
      workingDirectory: '/opt/nfl-quiz/app',
      environmentFile: '/etc/nfl-quiz.env',
      execStart:
        '/opt/nfl-quiz/venv/bin/gunicorn --bind 127.0.0.1:__PORT__ app:app',
    },
  },
  {
    id: 'deephaven-experiments',
    repoName: 'ran310/deephaven-experiments',
    s3ArtifactPrefix: 'deephaven-experiments',
    pathPrefix: '/deephaven-experiments',
    upstreamPort: 8082,
    codeDeploy: true,
    httpsUrlOutputConstructId: 'DeephavenExperimentsHttpsUrl',
    httpUrlOutputConstructId: 'DeephavenExperimentsUrl',
    userDataBootstrap: {
      optDir: '/opt/deephaven-experiments',
      systemdServiceName: 'deephaven-experiments',
      systemdDescription: 'Deephaven experiments (Gunicorn + embedded Deephaven)',
      conditionPathExists: '/opt/deephaven-experiments/venv/bin/gunicorn',
      workingDirectory: '/opt/deephaven-experiments/app',
      environmentFile: '/etc/deephaven-experiments.env',
      extraEnvLines: [
        'JAVA_HOME=/usr/lib/jvm/java-17-amazon-corretto',
        'FLASK_PORT=__PORT__',
        'DEEPHAVEN_HEAP=-Xmx4g',
        'DEEPHAVEN_PORT=10000',
      ],
      execStart:
        '/opt/deephaven-experiments/venv/bin/gunicorn --bind 127.0.0.1:__PORT__ --workers 1 --threads 4 --timeout 300 backend.app:app',
      restartSec: '10',
    },
  },
  {
    id: 'aws-health-dashboard',
    repoName: 'ran310/aws-health-dashboard',
    s3ArtifactPrefix: 'aws-health-dashboard',
    pathPrefix: '/aws-health-dashboard',
    upstreamPort: 8083,
    codeDeploy: true,
    attachHealthDashboardInstancePolicy: true,
  },
];

export function assertValidNginxApps(apps: Ec2NginxAppDefinition[]): void {
  const roots = apps.filter((a) => a.pathPrefix === '');
  if (roots.length !== 1) {
    throw new Error(
      `EC2_NGINX_APPS: expected exactly one root app (pathPrefix ""), got ${roots.length}`,
    );
  }
  const ports = new Map<number, string>();
  for (const a of apps) {
    if (a.pathPrefix !== '' && !a.pathPrefix.startsWith('/')) {
      throw new Error(`App ${a.id}: pathPrefix must be "" or start with /`);
    }
    if (a.pathPrefix.length > 1 && a.pathPrefix.endsWith('/')) {
      throw new Error(`App ${a.id}: pathPrefix must not end with /`);
    }
    const prev = ports.get(a.upstreamPort);
    if (prev) {
      throw new Error(
        `Duplicate upstream port ${a.upstreamPort} on ${prev} and ${a.id}`,
      );
    }
    ports.set(a.upstreamPort, a.id);
  }
}

export function healthDashboardPolicyStatement(): iam.PolicyStatement {
  return healthDashboardReadOnlyPolicy;
}

/** Static nginx demos on the instance (not Gunicorn apps). */
export const EC2_NGINX_GLOBAL_LOCATION_SNIPPETS = [
  '    location /app1/ {',
  '        alias /var/www/app1/;',
  '        index index.html;',
  '    }',
  '',
  '    location /app2/ {',
  '        alias /var/www/app2/;',
  '        index index.html;',
  '    }',
].join('\n');
