import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { stackDescription } from '../config';

export interface RdsPostgresStackProps extends cdk.StackProps {
  readonly projectName: string;
  readonly vpc: ec2.IVpc;
  /** Security groups allowed to connect on 5432 (e.g. nginx EC2, future VPC Lambdas). */
  readonly clientSecurityGroups: ec2.ISecurityGroup[];
}

/**
 * PostgreSQL in private subnets for experiments. Credentials in Secrets Manager.
 */
export class RdsPostgresStack extends cdk.Stack {
  public readonly database: rds.DatabaseInstance;
  public readonly databaseSecret: secretsmanager.ISecret;

  constructor(scope: Construct, id: string, props: RdsPostgresStackProps) {
    super(scope, id, {
      ...props,
      description: stackDescription('RDS PostgreSQL (private subnets)'),
    });

    const { vpc, projectName, clientSecurityGroups } = props;

    const dbSg = new ec2.SecurityGroup(this, 'DatabaseSg', {
      vpc,
      description: 'RDS PostgreSQL',
      allowAllOutbound: true,
    });
    for (const clientSg of clientSecurityGroups) {
      dbSg.addIngressRule(clientSg, ec2.Port.tcp(5432), 'Postgres from app tier');
    }

    this.database = new rds.DatabaseInstance(this, 'Postgres', {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_16_6,
      }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [dbSg],
      allocatedStorage: 20,
      maxAllocatedStorage: 50,
      storageEncrypted: true,
      publiclyAccessible: false,
      credentials: rds.Credentials.fromGeneratedSecret('postgres', {
        secretName: `${projectName}/rds/postgres`,
      }),
      databaseName: 'app',
      backupRetention: cdk.Duration.days(1),
      deletionProtection: false,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      deleteAutomatedBackups: true,
    });

    this.databaseSecret = this.database.secret!;

    new cdk.CfnOutput(this, 'RdsEndpoint', {
      value: this.database.instanceEndpoint.hostname,
      description: 'PostgreSQL host (port 5432)',
    });
    new cdk.CfnOutput(this, 'RdsSecretArn', {
      value: this.databaseSecret.secretArn,
      description: 'Secrets Manager ARN for DB credentials',
    });
  }
}
