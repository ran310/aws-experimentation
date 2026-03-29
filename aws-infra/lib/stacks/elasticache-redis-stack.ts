import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elasticache from 'aws-cdk-lib/aws-elasticache';
import { Construct } from 'constructs';
import { stackDescription } from '../config';

export interface ElastiCacheRedisStackProps extends cdk.StackProps {
  readonly projectName: string;
  readonly vpc: ec2.IVpc;
  readonly clientSecurityGroups: ec2.ISecurityGroup[];
}

/**
 * Single-node Redis in private subnets (L1 construct — good for learning / cost control).
 */
export class ElastiCacheRedisStack extends cdk.Stack {
  public readonly redisCluster: elasticache.CfnCacheCluster;
  public readonly redisSecurityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: ElastiCacheRedisStackProps) {
    super(scope, id, {
      ...props,
      description: stackDescription('ElastiCache Redis (private subnets)'),
    });

    const { vpc, clientSecurityGroups, projectName } = props;
    cdk.Tags.of(this).add('Project', projectName);

    const privateSubnets = vpc.selectSubnets({
      subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
    });

    const subnetGroup = new elasticache.CfnSubnetGroup(this, 'RedisSubnetGroup', {
      description: 'Private subnets for Redis',
      subnetIds: privateSubnets.subnetIds,
    });

    this.redisSecurityGroup = new ec2.SecurityGroup(this, 'RedisSg', {
      vpc,
      description: 'ElastiCache Redis',
      allowAllOutbound: true,
    });
    for (const clientSg of clientSecurityGroups) {
      this.redisSecurityGroup.addIngressRule(clientSg, ec2.Port.tcp(6379), 'Redis from app tier');
    }

    this.redisCluster = new elasticache.CfnCacheCluster(this, 'Redis', {
      engine: 'redis',
      engineVersion: '7.1',
      cacheNodeType: 'cache.t4g.micro',
      numCacheNodes: 1,
      port: 6379,
      vpcSecurityGroupIds: [this.redisSecurityGroup.securityGroupId],
      cacheSubnetGroupName: subnetGroup.ref,
    });
    this.redisCluster.addDependency(subnetGroup);

    new cdk.CfnOutput(this, 'RedisPrimaryEndpoint', {
      value: this.redisCluster.attrRedisEndpointAddress,
      description: 'Redis host (port 6379)',
    });
  }
}
