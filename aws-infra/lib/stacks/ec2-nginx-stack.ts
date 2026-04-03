import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cdk from 'aws-cdk-lib';
import * as codedeploy from 'aws-cdk-lib/aws-codedeploy';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as elbv2_targets from 'aws-cdk-lib/aws-elasticloadbalancingv2-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53_targets from 'aws-cdk-lib/aws-route53-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { Construct } from 'constructs';
import {
  fqdnToRelativeRecordName,
  PublicAlbHttpsContext,
  stackDescription,
} from '../config';

/** Path prefix where nfl-quiz is served (must match Flask APPLICATION_ROOT / nginx). */
export const NFL_QUIZ_PATH_PREFIX = '/nfl-quiz';

/** Gunicorn port for nfl-quiz (must match deploy/application_start.sh and nginx). */
export const NFL_QUIZ_UPSTREAM_PORT = 8080;

/** Path prefix for the AWS health dashboard (must match app APPLICATION_ROOT / nginx). */
export const AWS_HEALTH_DASHBOARD_PATH_PREFIX = '/aws-health-dashboard';

/** Gunicorn port for aws-health-dashboard (must match deploy/application_start.sh). */
export const AWS_HEALTH_DASHBOARD_UPSTREAM_PORT = 8083;

/**
 * Path prefix for deephaven-experiments (must match app APPLICATION_ROOT / nginx).
 */
export const DEEPHAVEN_EXPERIMENTS_PATH_PREFIX = '/deephaven-experiments';

/** Upstream port for deephaven-experiments (must match systemd / deploy). */
export const DEEPHAVEN_EXPERIMENTS_UPSTREAM_PORT = 8082;

/**
 * Gunicorn port for project-showcase (served at `/` — must match deploy/remote-install.sh).
 */
export const PROJECT_SHOWCASE_UPSTREAM_PORT = 8081;

export interface Ec2NginxStackProps extends cdk.StackProps {
  readonly projectName: string;
  readonly vpc: ec2.IVpc;
  /**
   * ACM + internet ALB + Route 53 aliases. TLS terminates at ALB; nginx stays on :80.
   * Omit for Elastic IP + direct HTTP/HTTPS to the instance (manual Certbot on :443).
   */
  readonly publicAlbHttps?: PublicAlbHttpsContext;
}

function relativeAliasNames(cfg: PublicAlbHttpsContext): string[] {
  if (cfg.aliasNames !== undefined && cfg.aliasNames.length > 0) {
    return [...new Set(cfg.aliasNames)];
  }
  const primary = cfg.certificateDomainName;
  const sans = cfg.subjectAlternativeNames ?? [];
  const rel = [primary, ...sans].map((d) => fqdnToRelativeRecordName(d, cfg.zoneName));
  return [...new Set(rel)];
}

/** Default nginx host: **8 GiB RAM** (t4g.large). Override in code if you want a different size. */
export const EC2_NGINX_INSTANCE_SIZE = ec2.InstanceSize.LARGE;

/**
 * Single Graviton instance (see {@link EC2_NGINX_INSTANCE_SIZE}) in a public subnet: **project-showcase** is proxied to Gunicorn on
 * {@link PROJECT_SHOWCASE_UPSTREAM_PORT} at **`/`**; **nfl-quiz** on {@link NFL_QUIZ_UPSTREAM_PORT} under
 * {@link NFL_QUIZ_PATH_PREFIX}; **deephaven-experiments** on {@link DEEPHAVEN_EXPERIMENTS_UPSTREAM_PORT}
 * under {@link DEEPHAVEN_EXPERIMENTS_PATH_PREFIX}. ALB health checks **`/nginx-health`** so the target stays healthy
 * before the showcase app is installed.
 *
 * Either **Elastic IP** + open 80/443 to the world, or **publicAlbHttps** (ACM + ALB + Route 53)
 * for fully automated TLS with no instance login.
 */
export class Ec2NginxStack extends cdk.Stack {
  public readonly instance: ec2.Instance;
  public readonly instanceSecurityGroup: ec2.SecurityGroup;
  public readonly artifactBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: Ec2NginxStackProps) {
    super(scope, id, {
      ...props,
      description: stackDescription('EC2 t4g + nginx multi-app paths'),
    });

    const { vpc, projectName, publicAlbHttps: httpsCfg } = props;
    const quizPath = NFL_QUIZ_PATH_PREFIX;
    const nflQuizPort = NFL_QUIZ_UPSTREAM_PORT;
    const deephavenPath = DEEPHAVEN_EXPERIMENTS_PATH_PREFIX;
    const deephavenPort = DEEPHAVEN_EXPERIMENTS_UPSTREAM_PORT;
    const showcasePort = PROJECT_SHOWCASE_UPSTREAM_PORT;
    const healthDashPath = AWS_HEALTH_DASHBOARD_PATH_PREFIX;
    const healthDashPort = AWS_HEALTH_DASHBOARD_UPSTREAM_PORT;

    this.artifactBucket = new s3.Bucket(this, 'NflQuizArtifacts', {
      bucketName: `${projectName}-nfl-quiz-${cdk.Aws.ACCOUNT_ID}-${cdk.Aws.REGION}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    let albSg: ec2.SecurityGroup | undefined;
    if (httpsCfg) {
      albSg = new ec2.SecurityGroup(this, 'AlbSg', {
        vpc,
        description: 'Internet ALB (ACM TLS)',
        allowAllOutbound: true,
      });
      albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS from internet');
      albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'HTTP redirect to HTTPS');
    }

    this.instanceSecurityGroup = new ec2.SecurityGroup(this, 'InstanceSg', {
      vpc,
      description: 'nginx host',
      allowAllOutbound: true,
    });
    if (httpsCfg && albSg) {
      this.instanceSecurityGroup.addIngressRule(albSg, ec2.Port.tcp(80), 'HTTP from ALB only');
    } else {
      this.instanceSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'HTTP');
      this.instanceSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS');
    }

    const role = new iam.Role(this, 'InstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
        // Required by the CodeDeploy agent to download deployment bundles from S3.
        // Policy ARN is .../policy/service-role/AmazonEC2RoleforAWSCodeDeploy (not .../policy/AmazonEC2RoleforAWSCodeDeploy).
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonEC2RoleforAWSCodeDeploy'),
      ],
    });

    this.artifactBucket.grantRead(role, 'nfl-quiz/*');
    /** Tarballs for project-showcase (GitHub → S3 → SSM pull on instance). */
    this.artifactBucket.grantRead(role, 'project-showcase/*');
    this.artifactBucket.grantRead(role, 'deephaven-experiments/*');
    /** CodeDeploy bundles for aws-health-dashboard (GitHub → S3 → CodeDeploy). */
    this.artifactBucket.grantRead(role, 'aws-health-dashboard/*');
    /** Canonical nginx site config (S3 → SSM on each Ec2Nginx deploy). */
    this.artifactBucket.grantRead(role, 'nginx-config/*');

    // Read-only AWS permissions needed by the health dashboard backend (boto3).
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'HealthDashboardReadOnly',
      actions: [
        // ListStacks: required for "list all stacks" (CLI + boto3 paginator paths).
        // DescribeStacks alone is not always sufficient on the instance role.
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
        // AWS Health requires Business/Enterprise support; safe to include —
        // the app handles AccessDeniedException gracefully.
        'health:DescribeEvents',
        'health:DescribeEventDetails',
        'health:DescribeAffectedEntities',
      ],
      resources: ['*'],
    }));

    const userData = ec2.UserData.forLinux();
    const nginxConfPath = `/etc/nginx/conf.d/${projectName}-apps.conf`;
    const nginxSite = [
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
      `    location = ${quizPath} {`,
      `        return 301 ${quizPath}/;`,
      '    }',
      '',
      `    location ${quizPath}/ {`,
      `        proxy_pass http://127.0.0.1:${nflQuizPort}/;`,
      '        proxy_http_version 1.1;',
      '        proxy_set_header Host $host;',
      '        proxy_set_header X-Real-IP $remote_addr;',
      '        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;',
      '        proxy_set_header X-Forwarded-Proto $scheme;',
      `        proxy_set_header X-Forwarded-Prefix ${quizPath};`,
      '    }',
      '',
      `    location = ${deephavenPath} {`,
      `        return 301 ${deephavenPath}/;`,
      '    }',
      '',
      `    location ${deephavenPath}/ {`,
      `        proxy_pass http://127.0.0.1:${deephavenPort}/;`,
      '        proxy_http_version 1.1;',
      '        proxy_set_header Host $host;',
      '        proxy_set_header X-Real-IP $remote_addr;',
      '        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;',
      '        proxy_set_header X-Forwarded-Proto $scheme;',
      `        proxy_set_header X-Forwarded-Prefix ${deephavenPath};`,
      '    }',
      '',
      '    location /app2/ {',
      '        alias /var/www/app2/;',
      '        index index.html;',
      '    }',
      '',
      `    location = ${healthDashPath} {`,
      `        return 301 ${healthDashPath}/;`,
      '    }',
      '',
      `    location ${healthDashPath}/ {`,
      `        proxy_pass http://127.0.0.1:${healthDashPort}/;`,
      '        proxy_http_version 1.1;',
      '        proxy_set_header Host $host;',
      '        proxy_set_header X-Real-IP $remote_addr;',
      '        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;',
      '        proxy_set_header X-Forwarded-Proto $scheme;',
      `        proxy_set_header X-Forwarded-Prefix ${healthDashPath};`,
      '    }',
      '',
      '    location = /project-showcase {',
      '        return 301 /;',
      '    }',
      '    location /project-showcase/ {',
      '        rewrite ^/project-showcase/(.*)$ /$1 permanent;',
      '    }',
      '',
      `    location / {`,
      `        proxy_pass http://127.0.0.1:${showcasePort}/;`,
      '        proxy_http_version 1.1;',
      '        proxy_set_header Host $host;',
      '        proxy_set_header X-Real-IP $remote_addr;',
      '        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;',
      '        proxy_set_header X-Forwarded-Proto $scheme;',
      '        proxy_set_header X-Forwarded-Prefix "";',
      '    }',
      '}',
    ].join('\n');

    const systemdUnit = [
      '[Unit]',
      'Description=NFL Quiz (Gunicorn)',
      'After=network.target',
      'ConditionPathExists=/opt/nfl-quiz/venv/bin/gunicorn',
      '',
      '[Service]',
      'Type=simple',
      'User=root',
      'WorkingDirectory=/opt/nfl-quiz/app',
      'EnvironmentFile=/etc/nfl-quiz.env',
      `ExecStart=/opt/nfl-quiz/venv/bin/gunicorn --bind 127.0.0.1:${nflQuizPort} app:app`,
      'Restart=on-failure',
      'RestartSec=5',
      '',
      '[Install]',
      'WantedBy=multi-user.target',
    ].join('\n');

    // Matches deephaven-experiments deploy/remote-install.sh: Flask lives under backend/; one Gunicorn
    // worker because Deephaven embeds a singleton JVM.
    const systemdUnitDeephaven = [
      '[Unit]',
      'Description=Deephaven experiments (Gunicorn + embedded Deephaven)',
      'After=network.target',
      'ConditionPathExists=/opt/deephaven-experiments/venv/bin/gunicorn',
      '',
      '[Service]',
      'Type=simple',
      'User=root',
      'WorkingDirectory=/opt/deephaven-experiments/app',
      'EnvironmentFile=/etc/deephaven-experiments.env',
      `ExecStart=/opt/deephaven-experiments/venv/bin/gunicorn --bind 127.0.0.1:${deephavenPort} --workers 1 --threads 4 --timeout 300 backend.app:app`,
      'Restart=on-failure',
      'RestartSec=10',
      '',
      '[Install]',
      'WantedBy=multi-user.target',
    ].join('\n');

    const nginxB64 = Buffer.from(nginxSite, 'utf8').toString('base64');
    const unitB64 = Buffer.from(systemdUnit, 'utf8').toString('base64');
    const unitDeephavenB64 = Buffer.from(systemdUnitDeephaven, 'utf8').toString('base64');

    userData.addCommands(
      'set -euxo pipefail',
      'dnf install -y nginx python3.11 python3.11-pip awscli java-17-amazon-corretto-headless ruby',
      // CodeDeploy agent — needed for aws-health-dashboard deployments.
      // NOTE: only runs on fresh instance launches; to install on an existing instance,
      // run this block manually via SSM or SSH.
      `wget -q -O /tmp/codedeploy-install https://aws-codedeploy-${cdk.Aws.REGION}.s3.${cdk.Aws.REGION}.amazonaws.com/latest/install`,
      'chmod +x /tmp/codedeploy-install',
      '/tmp/codedeploy-install auto',
      'systemctl enable codedeploy-agent',
      'systemctl start codedeploy-agent',
      'mkdir -p /opt/nfl-quiz/app',
      `printf '%s' 'APPLICATION_ROOT=${quizPath}' > /etc/nfl-quiz.env`,
      `printf '%s' '${unitB64}' | base64 -d > /etc/systemd/system/nfl-quiz.service`,
      'mkdir -p /opt/deephaven-experiments/app',
      // t4g.large baseline (8 GiB RAM). Tune in /etc/deephaven-experiments.env after deploy if needed.
      `printf '%s\n' 'JAVA_HOME=/usr/lib/jvm/java-17-amazon-corretto' 'FLASK_PORT=${deephavenPort}' 'DEEPHAVEN_HEAP=-Xmx4g' 'DEEPHAVEN_PORT=10000' 'APPLICATION_ROOT=${deephavenPath}' > /etc/deephaven-experiments.env`,
      `printf '%s' '${unitDeephavenB64}' | base64 -d > /etc/systemd/system/deephaven-experiments.service`,
      'systemctl daemon-reload',
      'mkdir -p /var/www/app1 /var/www/app2',
      'echo "<h1>App 1</h1><p>Path: /app1</p>" > /var/www/app1/index.html',
      'echo "<h1>App 2</h1><p>Path: /app2</p>" > /var/www/app2/index.html',
      `printf '%s' '${nginxB64}' | base64 -d > ${nginxConfPath}`,
      'nginx -t',
      'systemctl enable nginx',
      'systemctl restart nginx',
    );

    // Default AL2023 root is often 8 GiB — too small for large pip installs (e.g. Deephaven). GP3 is cost-effective.
    const rootVolumeGiB = 30;

    // Logical ID is part of the CloudFormation resource name. If the instance is terminated in the
    // console, bump this id (e.g. V2 → V3) so the next deploy creates a fresh instance; an unchanged
    // template usually will not "heal" a missing EC2.
    this.instance = new ec2.Instance(this, 'NginxHostV2', {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, EC2_NGINX_INSTANCE_SIZE),
      machineImage: ec2.MachineImage.latestAmazonLinux2023({
        cpuType: ec2.AmazonLinuxCpuType.ARM_64,
      }),
      securityGroup: this.instanceSecurityGroup,
      role,
      userData,
      associatePublicIpAddress: true,
      blockDevices: [
        {
          deviceName: '/dev/xvda',
          volume: ec2.BlockDeviceVolume.ebs(rootVolumeGiB, {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
            deleteOnTermination: true,
          }),
        },
      ],
    });

    cdk.Tags.of(this.instance).add('Name', `${projectName}-nginx`);
    // Shared tag: every nginx app repo targets this instance. Use one CodeDeploy application but
    // **separate deployment groups per app** so each group keeps its own last-successful revision.
    // A single shared deployment group would interleave revisions across repos and can run the wrong
    // ApplicationStop / lifecycle hooks for the next deploy.
    cdk.Tags.of(this.instance).add('Ec2NginxCodeDeploy', 'true');

    // ── Nginx config: S3 + SSM on every deploy (user-data only runs at launch) ─────────
    const nginxObjectKey = `${projectName}-apps.conf`;
    const nginxS3Key = `nginx-config/${nginxObjectKey}`;
    const nginxConfigHash = createHash('sha256').update(nginxSite).digest('hex').slice(0, 32);

    const nginxBucketDeploy = new s3deploy.BucketDeployment(this, 'NginxConfigToS3', {
      sources: [s3deploy.Source.data(nginxObjectKey, nginxSite)],
      destinationBucket: this.artifactBucket,
      destinationKeyPrefix: 'nginx-config/',
      prune: false,
      memoryLimit: 256,
    });

    const skipNginxSsm =
      this.node.tryGetContext('skipNginxSsmApply') === true ||
      this.node.tryGetContext('skipNginxSsmApply') === 'true';

    if (!skipNginxSsm) {
      const applyNginxScript = [
        '#!/bin/bash',
        'set -euxo pipefail',
        `CONF=${nginxConfPath}`,
        `aws s3 cp "s3://${this.artifactBucket.bucketName}/${nginxS3Key}" /tmp/nginx-apps.new`,
        'install -m 644 /tmp/nginx-apps.new "$CONF"',
        'rm -f /tmp/nginx-apps.new',
        'if [[ -f /etc/nginx/conf.d/default.conf ]]; then mv /etc/nginx/conf.d/default.conf /etc/nginx/conf.d/default.conf.cdk-disabled; fi',
        'nginx -t',
        'systemctl reload nginx',
      ].join('\n');

      const ssmApply: cr.AwsSdkCall = {
        service: 'SSM',
        action: 'sendCommand',
        parameters: {
          DocumentName: 'AWS-RunShellScript',
          Parameters: { commands: [applyNginxScript] },
          Targets: [{ Key: 'tag:Ec2NginxCodeDeploy', Values: ['true'] }],
          TimeoutSeconds: 120,
          MaxConcurrency: '1',
          MaxErrors: '1',
        },
        physicalResourceId: cr.PhysicalResourceId.of(nginxConfigHash),
      };

      const applyNginxOnInstance = new cr.AwsCustomResource(this, 'ApplyNginxConfigViaSsm', {
        onCreate: ssmApply,
        onUpdate: ssmApply,
        policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
          resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE,
        }),
        installLatestAwsSdk: true,
      });
      applyNginxOnInstance.node.addDependency(this.instance);
      applyNginxOnInstance.node.addDependency(nginxBucketDeploy);
    }

    // ── CodeDeploy (one application, one deployment group per nginx app repo) ──
    const codeDeployServiceRole = new iam.Role(this, 'CodeDeployServiceRole', {
      assumedBy: new iam.ServicePrincipal('codedeploy.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSCodeDeployRole'),
      ],
    });

    const codeDeployApp = new codedeploy.ServerApplication(this, 'NginxSharedCodeDeployApp', {
      applicationName: `${projectName}-ec2-nginx-apps`,
    });

    const nginxCodeDeployTags = new codedeploy.InstanceTagSet({
      Ec2NginxCodeDeploy: ['true'],
    });

    const dgBase = {
      application: codeDeployApp,
      role: codeDeployServiceRole,
      ec2InstanceTags: nginxCodeDeployTags,
      installAgent: false,
      deploymentConfig: codedeploy.ServerDeploymentConfig.ONE_AT_A_TIME,
    };

    const dgProjectShowcase = new codedeploy.ServerDeploymentGroup(this, 'DgProjectShowcase', {
      ...dgBase,
      deploymentGroupName: `${projectName}-ec2-nginx-dg-project-showcase`,
    });
    const dgNflQuiz = new codedeploy.ServerDeploymentGroup(this, 'DgNflQuiz', {
      ...dgBase,
      deploymentGroupName: `${projectName}-ec2-nginx-dg-nfl-quiz`,
    });
    const dgAwsHealthDashboard = new codedeploy.ServerDeploymentGroup(this, 'DgAwsHealthDashboard', {
      ...dgBase,
      deploymentGroupName: `${projectName}-ec2-nginx-dg-aws-health-dashboard`,
    });
    const dgDeephavenExperiments = new codedeploy.ServerDeploymentGroup(this, 'DgDeephavenExperiments', {
      ...dgBase,
      deploymentGroupName: `${projectName}-ec2-nginx-dg-deephaven-experiments`,
    });

    new cdk.CfnOutput(this, 'CodeDeployAppName', {
      value: codeDeployApp.applicationName,
      description: 'Shared CodeDeploy application — same for all nginx app workflows',
    });
    new cdk.CfnOutput(this, 'CodeDeployDeploymentGroupNameProjectShowcase', {
      value: dgProjectShowcase.deploymentGroupName,
      description: 'project-showcase workflow: use this deployment group name',
    });
    new cdk.CfnOutput(this, 'CodeDeployDeploymentGroupNameNflQuiz', {
      value: dgNflQuiz.deploymentGroupName,
      description: 'nfl-quiz workflow: use this deployment group name',
    });
    new cdk.CfnOutput(this, 'CodeDeployDeploymentGroupNameAwsHealthDashboard', {
      value: dgAwsHealthDashboard.deploymentGroupName,
      description: 'aws-health-dashboard workflow: use this deployment group name',
    });
    new cdk.CfnOutput(this, 'CodeDeployDeploymentGroupNameDeephavenExperiments', {
      value: dgDeephavenExperiments.deploymentGroupName,
      description: 'deephaven-experiments workflow: use this deployment group name',
    });

    if (httpsCfg && albSg) {
      const hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'PublicZone', {
        hostedZoneId: httpsCfg.hostedZoneId,
        zoneName: httpsCfg.zoneName,
      });

      const sans = httpsCfg.subjectAlternativeNames ?? [];
      const certificate = new acm.Certificate(this, 'SiteCertificate', {
        domainName: httpsCfg.certificateDomainName,
        subjectAlternativeNames: sans.length > 0 ? sans : undefined,
        validation: acm.CertificateValidation.fromDns(hostedZone),
      });

      const albName = `${projectName}-alb`.replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 32);
      const alb = new elbv2.ApplicationLoadBalancer(this, 'PublicAlb', {
        vpc,
        internetFacing: true,
        loadBalancerName: albName,
        securityGroup: albSg,
      });

      const targetGroup = new elbv2.ApplicationTargetGroup(this, 'NginxTargetGroup', {
        vpc,
        port: 80,
        protocol: elbv2.ApplicationProtocol.HTTP,
        targets: [new elbv2_targets.InstanceTarget(this.instance, 80)],
        healthCheck: {
          path: '/nginx-health',
          healthyHttpCodes: '200-399',
        },
      });

      alb.addListener('Https', {
        port: 443,
        protocol: elbv2.ApplicationProtocol.HTTPS,
        certificates: [certificate],
        defaultAction: elbv2.ListenerAction.forward([targetGroup]),
      });

      alb.addListener('HttpRedirect', {
        port: 80,
        protocol: elbv2.ApplicationProtocol.HTTP,
        defaultAction: elbv2.ListenerAction.redirect({
          protocol: 'HTTPS',
          port: '443',
          permanent: true,
        }),
      });

      const labels = relativeAliasNames(httpsCfg);
      labels.forEach((label, i) => {
        new route53.ARecord(this, `AlbAlias${i}`, {
          zone: hostedZone,
          recordName: label.length > 0 ? label : undefined,
          target: route53.RecordTarget.fromAlias(new route53_targets.LoadBalancerTarget(alb)),
        });
      });

      const albDnsName = alb.loadBalancerDnsName;
      new cdk.CfnOutput(this, 'LoadBalancerDns', {
        value: albDnsName,
        description: 'ALB DNS (alias records point here)',
      });
      new cdk.CfnOutput(this, 'NginxHttpsBaseUrl', {
        value: `https://${httpsCfg.certificateDomainName}/`,
        description: 'HTTPS base URL — project-showcase (root /)',
      });
      new cdk.CfnOutput(this, 'NflQuizHttpsUrl', {
        value: cdk.Fn.join('', ['https://', httpsCfg.certificateDomainName, `${quizPath}/`]),
        description: 'HTTPS nfl-quiz URL',
      });
      new cdk.CfnOutput(this, 'DeephavenExperimentsHttpsUrl', {
        value: cdk.Fn.join('', ['https://', httpsCfg.certificateDomainName, `${deephavenPath}/`]),
        description: 'HTTPS deephaven-experiments URL',
      });
    } else {
      const eip = new ec2.CfnEIP(this, 'NginxEip', {
        domain: 'vpc',
        tags: [{ key: 'Name', value: `${projectName}-nginx-eip` }],
      });

      new ec2.CfnEIPAssociation(this, 'NginxEipAssoc', {
        allocationId: eip.attrAllocationId,
        instanceId: this.instance.instanceId,
      });

      new cdk.CfnOutput(this, 'NginxElasticIp', {
        value: eip.attrPublicIp,
        description: 'Stable public IPv4 (Elastic IP) for http://IP/',
      });

      new cdk.CfnOutput(this, 'NginxPublicIp', {
        value: eip.attrPublicIp,
        description:
          'Same as NginxElasticIp — / is project-showcase; also /nfl-quiz/, /deephaven-experiments/, /app1/, /app2/',
      });

      new cdk.CfnOutput(this, 'NflQuizUrl', {
        value: cdk.Fn.join('', ['http://', eip.attrPublicIp, `${quizPath}/`]),
        description: 'HTTP nfl-quiz URL',
      });

      new cdk.CfnOutput(this, 'DeephavenExperimentsUrl', {
        value: cdk.Fn.join('', ['http://', eip.attrPublicIp, `${deephavenPath}/`]),
        description: 'HTTP deephaven-experiments URL',
      });
    }

    new cdk.CfnOutput(this, 'NginxInstanceId', { value: this.instance.instanceId });

    new cdk.CfnOutput(this, 'Ec2NginxArtifactBucketName', {
      value: this.artifactBucket.bucketName,
      description:
        'S3 bucket for app deploy tarballs (prefix per app: nfl-quiz/, project-showcase/, deephaven-experiments/)',
    });
  }
}
