import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';
import { stackDescription } from '../config';

export interface NetworkStackProps extends cdk.StackProps {
  readonly projectName: string;
}

/**
 * Shared VPC: public subnets (ingress / NAT) and private subnets (RDS, ElastiCache, etc.).
 */
export class NetworkStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc;

  constructor(scope: Construct, id: string, props: NetworkStackProps) {
    super(scope, id, {
      ...props,
      description: stackDescription('shared VPC (public + private subnets, single NAT)'),
    });

    const name = props.projectName;

    this.vpc = new ec2.Vpc(this, 'Vpc', {
      vpcName: `${name}-vpc`,
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        {
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
        {
          name: 'Private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 24,
        },
      ],
    });

    new cdk.CfnOutput(this, 'VpcId', { value: this.vpc.vpcId });
    new cdk.CfnOutput(this, 'VpcCidr', { value: this.vpc.vpcCidrBlock });
  }
}
