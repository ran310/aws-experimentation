import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { stackDescription } from '../config';

export interface Ec2NginxStackProps extends cdk.StackProps {
  readonly projectName: string;
  readonly vpc: ec2.IVpc;
}

/**
 * Single t4g.nano in a public subnet: nginx routes multiple path prefixes (add more apps by extending user data / config).
 */
export class Ec2NginxStack extends cdk.Stack {
  public readonly instance: ec2.Instance;
  public readonly instanceSecurityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: Ec2NginxStackProps) {
    super(scope, id, {
      ...props,
      description: stackDescription('EC2 t4g.nano + nginx multi-app paths'),
    });

    const { vpc, projectName } = props;

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

    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      '#!/bin/bash',
      'set -euxo pipefail',
      'dnf install -y nginx',
      'mkdir -p /var/www/app1 /var/www/app2',
      'echo "<h1>App 1</h1><p>Path: /app1</p>" > /var/www/app1/index.html',
      'echo "<h1>App 2</h1><p>Path: /app2</p>" > /var/www/app2/index.html',
      `cat > /etc/nginx/conf.d/${projectName}-apps.conf <<'EOF'
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;

    location /app1/ {
        alias /var/www/app1/;
        index index.html;
    }
    location /app2/ {
        alias /var/www/app2/;
        index index.html;
    }
    location = / {
        default_type text/html;
        return 200 '<html><body><h1>${projectName} nginx</h1><p><a href="/app1/">/app1/</a> · <a href="/app2/">/app2/</a></p></body></html>';
    }
}
EOF`,
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

    new cdk.CfnOutput(this, 'NginxPublicIp', {
      value: this.instance.instancePublicIp,
      description: 'Public IPv4 - open http://IP/ (paths /app1/, /app2/)',
    });
    new cdk.CfnOutput(this, 'NginxInstanceId', { value: this.instance.instanceId });
  }
}
