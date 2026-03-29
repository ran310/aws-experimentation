import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Buffer } from 'node:buffer';
import { Construct } from 'constructs';
import { stackDescription } from '../config';

/** Path prefix where nfl-quiz is served (must match Flask APPLICATION_ROOT / nginx). */
export const NFL_QUIZ_PATH_PREFIX = '/nfl-quiz';

export interface Ec2NginxStackProps extends cdk.StackProps {
  readonly projectName: string;
  readonly vpc: ec2.IVpc;
}

/**
 * Single t4g.nano in a public subnet: nginx routes multiple path prefixes; nfl-quiz is proxied
 * to Gunicorn on :8080 under {@link NFL_QUIZ_PATH_PREFIX}. Elastic IP keeps a stable address.
 */
export class Ec2NginxStack extends cdk.Stack {
  public readonly instance: ec2.Instance;
  public readonly instanceSecurityGroup: ec2.SecurityGroup;
  public readonly artifactBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: Ec2NginxStackProps) {
    super(scope, id, {
      ...props,
      description: stackDescription('EC2 t4g.nano + nginx multi-app paths'),
    });

    const { vpc, projectName } = props;
    const quizPath = NFL_QUIZ_PATH_PREFIX;

    this.artifactBucket = new s3.Bucket(this, 'NflQuizArtifacts', {
      bucketName: `${projectName}-nfl-quiz-${cdk.Aws.ACCOUNT_ID}-${cdk.Aws.REGION}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    this.instanceSecurityGroup = new ec2.SecurityGroup(this, 'InstanceSg', {
      vpc,
      description: 'nginx host',
      allowAllOutbound: true,
    });
    this.instanceSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'HTTP');

    const role = new iam.Role(this, 'InstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });

    this.artifactBucket.grantRead(role, 'nfl-quiz/*');

    const userData = ec2.UserData.forLinux();
    const nginxConfPath = `/etc/nginx/conf.d/${projectName}-apps.conf`;
    const nginxSite = [
      'server {',
      '    listen 80 default_server;',
      '    listen [::]:80 default_server;',
      '    server_name _;',
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
      '    location /app1/ {',
      '        alias /var/www/app1/;',
      '        index index.html;',
      '    }',
      '    location /app2/ {',
      '        alias /var/www/app2/;',
      '        index index.html;',
      '    }',
      '    location = / {',
      '        default_type text/html;',
      `        return 200 '<html><body><h1>${projectName} nginx</h1><p><a href="${quizPath}/">${quizPath}/</a> (nfl-quiz) · <a href="/app1/">/app1/</a> · <a href="/app2/">/app2/</a></p></body></html>';`,
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

    const nginxB64 = Buffer.from(nginxSite, 'utf8').toString('base64');
    const unitB64 = Buffer.from(systemdUnit, 'utf8').toString('base64');

    userData.addCommands(
      'set -euxo pipefail',
      'dnf install -y nginx python3.11 python3.11-pip awscli',
      'mkdir -p /opt/nfl-quiz/app',
      `printf '%s' 'APPLICATION_ROOT=${quizPath}' > /etc/nfl-quiz.env`,
      `printf '%s' '${unitB64}' | base64 -d > /etc/systemd/system/nfl-quiz.service`,
      'systemctl daemon-reload',
      'mkdir -p /var/www/app1 /var/www/app2',
      'echo "<h1>App 1</h1><p>Path: /app1</p>" > /var/www/app1/index.html',
      'echo "<h1>App 2</h1><p>Path: /app2</p>" > /var/www/app2/index.html',
      `printf '%s' '${nginxB64}' | base64 -d > ${nginxConfPath}`,
      'nginx -t',
      'systemctl enable nginx',
      'systemctl restart nginx',
    );

    this.instance = new ec2.Instance(this, 'NginxHost', {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.NANO),
      machineImage: ec2.MachineImage.latestAmazonLinux2023({
        cpuType: ec2.AmazonLinuxCpuType.ARM_64,
      }),
      securityGroup: this.instanceSecurityGroup,
      role,
      userData,
      associatePublicIpAddress: true,
    });

    cdk.Tags.of(this.instance).add('Name', `${projectName}-nginx`);

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
      description: 'Same as NginxElasticIp — http://IP/ and paths /app1/, /app2/, /nfl-quiz/',
    });

    new cdk.CfnOutput(this, 'NginxInstanceId', { value: this.instance.instanceId });

    new cdk.CfnOutput(this, 'NflQuizArtifactBucketName', {
      value: this.artifactBucket.bucketName,
      description: 'S3 bucket for nfl-quiz release tarballs (prefix nfl-quiz/)',
    });

    new cdk.CfnOutput(this, 'NflQuizUrl', {
      value: cdk.Fn.join('', ['http://', eip.attrPublicIp, `${quizPath}/`]),
      description: 'Base URL for the nfl-quiz app',
    });
  }
}
