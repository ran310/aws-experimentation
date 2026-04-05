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
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { Construct } from 'constructs';
import {
  ec2NginxArtifactBucketSsmParameterName,
  fqdnToRelativeRecordName,
  PublicAlbHttpsContext,
  stackDescription,
} from '../config';
import {
  assertValidNginxApps,
  EC2_NGINX_APPS,
  healthDashboardPolicyStatement,
  nginxAppIdToPascal,
  type Ec2NginxAppDefinition,
} from '../config/ec2-nginx-apps';
import {
  renderNginxServerBlock,
  staticDemoHtmlUserData,
  userDataCommandsForAppBootstrap,
} from './ec2-nginx-helpers';

/** Default nginx host size (t4g.large, 8 GiB RAM). */
export const EC2_NGINX_INSTANCE_SIZE = ec2.InstanceSize.LARGE;

export interface Ec2NginxStackProps extends cdk.StackProps {
  readonly projectName: string;
  readonly vpc: ec2.IVpc;
  readonly publicAlbHttps?: PublicAlbHttpsContext;
  /**
   * When set, the instance role can read/write objects in this bucket (e.g. Iceberg warehouse).
   */
  readonly lakehouseBucket?: s3.IBucket;
  /**
   * Override the default app list from `lib/config/ec2-nginx-apps.ts` (tests / forks).
   */
  readonly hostedApps?: Ec2NginxAppDefinition[];
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

/**
 * Graviton nginx host: routes in {@link EC2_NGINX_APPS} (or `hostedApps`) define path → upstream port,
 * CodeDeploy groups, and optional first-boot systemd. ALB health check **`/nginx-health`**.
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
    const apps = props.hostedApps ?? EC2_NGINX_APPS;
    assertValidNginxApps(apps);

    this.artifactBucket = new s3.Bucket(this, 'NginxAppsArtifactBucket', {
      bucketName: `${projectName}-nginx-apps-${cdk.Aws.ACCOUNT_ID}-${cdk.Aws.REGION}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    new ssm.StringParameter(this, 'ArtifactBucketNameParam', {
      parameterName: ec2NginxArtifactBucketSsmParameterName(projectName),
      description: 'CodeDeploy / GitHub Actions nginx artifact bucket name',
      stringValue: this.artifactBucket.bucketName,
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
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonEC2RoleforAWSCodeDeploy'),
      ],
    });

    for (const a of apps) {
      this.artifactBucket.grantRead(role, `${a.s3ArtifactPrefix}/*`);
    }
    this.artifactBucket.grantRead(role, 'nginx-config/*');

    if (apps.some((a) => a.attachHealthDashboardInstancePolicy)) {
      role.addToPolicy(healthDashboardPolicyStatement());
    }

    if (props.lakehouseBucket) {
      props.lakehouseBucket.grantReadWrite(role);
    }

    const nginxConfPath = `/etc/nginx/conf.d/${projectName}-apps.conf`;
    const nginxSite = renderNginxServerBlock(apps);
    const nginxB64 = Buffer.from(nginxSite, 'utf8').toString('base64');

    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      'set -euxo pipefail',
      'dnf install -y nginx docker python3.11 python3.11-pip awscli java-17-amazon-corretto-headless ruby',
      'systemctl enable docker',
      'systemctl start docker',
      `wget -q -O /tmp/codedeploy-install https://aws-codedeploy-${cdk.Aws.REGION}.s3.${cdk.Aws.REGION}.amazonaws.com/latest/install`,
      'chmod +x /tmp/codedeploy-install',
      '/tmp/codedeploy-install auto',
      'systemctl enable codedeploy-agent',
      'systemctl start codedeploy-agent',
      ...apps.flatMap((a) => userDataCommandsForAppBootstrap(a)),
      ...apps.flatMap((a) => a.userDataExtra ?? []),
      'systemctl daemon-reload',
      ...staticDemoHtmlUserData(),
      `printf '%s' '${nginxB64}' | base64 -d > ${nginxConfPath}`,
      'nginx -t',
      'systemctl enable nginx',
      'systemctl restart nginx',
    );

    const rootVolumeGiB = 30;
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
    cdk.Tags.of(this.instance).add('Ec2NginxCodeDeploy', 'true');

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

    new cdk.CfnOutput(this, 'CodeDeployAppName', {
      value: codeDeployApp.applicationName,
      description: 'Shared CodeDeploy application — same for all nginx app workflows',
    });

    for (const app of apps.filter((a) => a.codeDeploy)) {
      const pascal = nginxAppIdToPascal(app.id);
      const dg = new codedeploy.ServerDeploymentGroup(this, `Dg${pascal}`, {
        ...dgBase,
        deploymentGroupName: `${projectName}-ec2-nginx-dg-${app.id}`,
      });
      new cdk.CfnOutput(this, `CodeDeployDeploymentGroupName${pascal}`, {
        value: dg.deploymentGroupName,
        description: `${app.id} workflow: deployment group name`,
      });
    }

    const rootApp = apps.find((a) => a.pathPrefix === '')!;
    const prefixedApps = apps.filter((a) => a.pathPrefix !== '');

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

      new cdk.CfnOutput(this, 'LoadBalancerDns', {
        value: alb.loadBalancerDnsName,
        description: 'ALB DNS (alias records point here)',
      });
      new cdk.CfnOutput(this, 'NginxHttpsBaseUrl', {
        value: `https://${httpsCfg.certificateDomainName}/`,
        description: `HTTPS base URL — ${rootApp.id} (root /)`,
      });
      for (const a of prefixedApps) {
        const pascal = nginxAppIdToPascal(a.id);
        const oid = a.httpsUrlOutputConstructId ?? `HttpsUrl${pascal}`;
        new cdk.CfnOutput(this, oid, {
          value: cdk.Fn.join('', ['https://', httpsCfg.certificateDomainName, `${a.pathPrefix}/`]),
          description: `HTTPS URL — ${a.id}`,
        });
      }
    } else {
      const eip = new ec2.CfnEIP(this, 'NginxEip', {
        domain: 'vpc',
        tags: [{ key: 'Name', value: `${projectName}-nginx-eip` }],
      });

      new ec2.CfnEIPAssociation(this, 'NginxEipAssoc', {
        allocationId: eip.attrAllocationId,
        instanceId: this.instance.instanceId,
      });

      const pathHint = prefixedApps.map((a) => `${a.pathPrefix}/`).join(', ');
      new cdk.CfnOutput(this, 'NginxElasticIp', {
        value: eip.attrPublicIp,
        description: 'Stable public IPv4 (Elastic IP) for http://IP/',
      });
      new cdk.CfnOutput(this, 'NginxPublicIp', {
        value: eip.attrPublicIp,
        description: `Same as NginxElasticIp — / is ${rootApp.id}; also ${pathHint}/app1/, /app2/`,
      });
      for (const a of prefixedApps) {
        const pascal = nginxAppIdToPascal(a.id);
        const oid = a.httpUrlOutputConstructId ?? `HttpUrl${pascal}`;
        new cdk.CfnOutput(this, oid, {
          value: cdk.Fn.join('', ['http://', eip.attrPublicIp, `${a.pathPrefix}/`]),
          description: `HTTP URL — ${a.id}`,
        });
      }
    }

    new cdk.CfnOutput(this, 'NginxInstanceId', { value: this.instance.instanceId });

    const prefixList = apps.map((a) => `${a.s3ArtifactPrefix}/`).join(', ');
    new cdk.CfnOutput(this, 'Ec2NginxArtifactBucketName', {
      value: this.artifactBucket.bucketName,
      description: `S3 bucket for deploy bundles (prefixes: ${prefixList}nginx-config/)`,
    });
  }
}
