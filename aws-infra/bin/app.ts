#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { projectName, publicAlbHttpsConfig } from '../lib/config';
import { Ec2NginxStack } from '../lib/stacks/ec2-nginx-stack';
import { ElastiCacheRedisStack } from '../lib/stacks/elasticache-redis-stack';
import { HttpApiStack } from '../lib/stacks/http-api-stack';
import { NetworkStack } from '../lib/stacks/network-stack';

const app = new cdk.App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
};

const name = projectName(app);
cdk.Tags.of(app).add('Project', name);
cdk.Tags.of(app).add('ManagedBy', 'cdk-aws-infra');

const network = new NetworkStack(app, 'AwsInfra-Network', {
  env,
  projectName: name,
});

const ec2Nginx = new Ec2NginxStack(app, 'AwsInfra-Ec2Nginx', {
  env,
  projectName: name,
  vpc: network.vpc,
  publicAlbHttps: publicAlbHttpsConfig(app),
});

const appTierClientSg = ec2Nginx.instanceSecurityGroup;

new ElastiCacheRedisStack(app, 'AwsInfra-ElastiCacheRedis', {
  env,
  projectName: name,
  vpc: network.vpc,
  clientSecurityGroups: [appTierClientSg],
});

new HttpApiStack(app, 'AwsInfra-HttpApi', {
  env,
  projectName: name,
});
