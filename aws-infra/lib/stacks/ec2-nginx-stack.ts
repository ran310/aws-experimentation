import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as elbv2_targets from 'aws-cdk-lib/aws-elasticloadbalancingv2-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53_targets from 'aws-cdk-lib/aws-route53-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Buffer } from 'node:buffer';
import { Construct } from 'constructs';
import {
  fqdnToRelativeRecordName,
  PublicAlbHttpsContext,
  stackDescription,
} from '../config';

/** Path prefix where nfl-quiz is served (must match Flask APPLICATION_ROOT / nginx). */
export const NFL_QUIZ_PATH_PREFIX = '/nfl-quiz';

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
 * {@link PROJECT_SHOWCASE_UPSTREAM_PORT} at **`/`**; **nfl-quiz** on :8080 under
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
    const deephavenPath = DEEPHAVEN_EXPERIMENTS_PATH_PREFIX;
    const deephavenPort = DEEPHAVEN_EXPERIMENTS_UPSTREAM_PORT;
    const showcasePort = PROJECT_SHOWCASE_UPSTREAM_PORT;

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
      ],
    });

    this.artifactBucket.grantRead(role, 'nfl-quiz/*');
    /** Tarballs for project-showcase (GitHub → S3 → SSM pull on instance). */
    this.artifactBucket.grantRead(role, 'project-showcase/*');
    this.artifactBucket.grantRead(role, 'deephaven-experiments/*');

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
      '        proxy_pass http://127.0.0.1:8080/;',
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
      '',
      '[Service]',
      'Type=simple',
      'User=root',
      'WorkingDirectory=/opt/nfl-quiz/app',
      'EnvironmentFile=/etc/nfl-quiz.env',
      'ExecStart=/opt/nfl-quiz/venv/bin/gunicorn --bind 127.0.0.1:8080 app:app',
      'Restart=on-failure',
      'RestartSec=5',
      'ConditionPathExists=/opt/nfl-quiz/venv/bin/gunicorn',
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
      '',
      '[Service]',
      'Type=simple',
      'User=root',
      'WorkingDirectory=/opt/deephaven-experiments/app',
      'EnvironmentFile=/etc/deephaven-experiments.env',
      `ExecStart=/opt/deephaven-experiments/venv/bin/gunicorn --bind 127.0.0.1:${deephavenPort} --workers 1 --threads 4 --timeout 300 backend.app:app`,
      'Restart=on-failure',
      'RestartSec=10',
      'ConditionPathExists=/opt/deephaven-experiments/venv/bin/gunicorn',
      '',
      '[Install]',
      'WantedBy=multi-user.target',
    ].join('\n');

    const nginxB64 = Buffer.from(nginxSite, 'utf8').toString('base64');
    const unitB64 = Buffer.from(systemdUnit, 'utf8').toString('base64');
    const unitDeephavenB64 = Buffer.from(systemdUnitDeephaven, 'utf8').toString('base64');

    userData.addCommands(
      'set -euxo pipefail',
      'dnf install -y nginx python3.11 python3.11-pip awscli java-17-amazon-corretto-headless',
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
