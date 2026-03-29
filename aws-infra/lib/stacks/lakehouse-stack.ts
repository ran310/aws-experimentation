import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { stackDescription } from '../config';

export interface LakehouseStackProps extends cdk.StackProps {
  readonly projectName: string;
  /**
   * Globally unique S3 bucket name. Default: `mylakehouse-{account}-{region}` so the
   * bucket is identifiable as the lake while staying unique across AWS.
   * Override with context `lakehouseBucketName` if you own a specific global name.
   */
  readonly bucketName?: string;
}

/**
 * Single S3 “lake” bucket for many datasets, plus **managed IAM policies** you attach to
 * application roles (Lambda, EC2, ECS, etc.) for shared read-only or read/write access.
 *
 * **Future:** add prefix-scoped policies or bucket policy conditions (e.g. `s3:prefix`)
 * when subsets of apps should only see `raw/`, `curated/`, etc.
 */
export class LakehouseStack extends cdk.Stack {
  public readonly bucket: s3.Bucket;
  /** Attach to roles that should list/read objects anywhere in the bucket. */
  public readonly readOnlyManagedPolicy: iam.ManagedPolicy;
  /** Attach to roles that should list/read/write/delete objects in the bucket. */
  public readonly readWriteManagedPolicy: iam.ManagedPolicy;

  constructor(scope: Construct, id: string, props: LakehouseStackProps) {
    super(scope, id, {
      ...props,
      description: stackDescription('S3 data lake + IAM policies for app access'),
    });

    const { projectName } = props;
    const bucketName =
      props.bucketName ??
      `mylakehouse-${cdk.Aws.ACCOUNT_ID}-${cdk.Aws.REGION}`;

    this.bucket = new s3.Bucket(this, 'LakeBucket', {
      bucketName,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: true,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    cdk.Tags.of(this.bucket).add('Name', 'mylakehouse');
    cdk.Tags.of(this.bucket).add('Project', projectName);

    const objectArn = this.bucket.arnForObjects('*');
    const bucketArn = this.bucket.bucketArn;

    this.readOnlyManagedPolicy = new iam.ManagedPolicy(this, 'LakehouseReadOnly', {
      managedPolicyName: `${projectName}-lakehouse-s3-readonly`,
      description: `Read-only access to lake bucket ${bucketName} (ListBucket + GetObject)`,
      statements: [
        new iam.PolicyStatement({
          sid: 'LakehouseGetObjects',
          effect: iam.Effect.ALLOW,
          actions: ['s3:GetObject', 's3:GetObjectVersion'],
          resources: [objectArn],
        }),
        new iam.PolicyStatement({
          sid: 'LakehouseListBucket',
          effect: iam.Effect.ALLOW,
          actions: ['s3:ListBucket', 's3:ListBucketVersions'],
          resources: [bucketArn],
        }),
      ],
    });

    this.readWriteManagedPolicy = new iam.ManagedPolicy(this, 'LakehouseReadWrite', {
      managedPolicyName: `${projectName}-lakehouse-s3-readwrite`,
      description: `Read/write access to lake bucket ${bucketName} (for ETL, writers, services)`,
      statements: [
        new iam.PolicyStatement({
          sid: 'LakehouseObjectRW',
          effect: iam.Effect.ALLOW,
          actions: [
            's3:GetObject',
            's3:GetObjectVersion',
            's3:PutObject',
            's3:DeleteObject',
            's3:AbortMultipartUpload',
            's3:ListMultipartUploadParts',
            's3:ListBucketMultipartUploads',
          ],
          resources: [objectArn],
        }),
        new iam.PolicyStatement({
          sid: 'LakehouseListBucket',
          effect: iam.Effect.ALLOW,
          actions: ['s3:ListBucket', 's3:ListBucketVersions'],
          resources: [bucketArn],
        }),
      ],
    });

    new cdk.CfnOutput(this, 'LakehouseBucketName', {
      value: this.bucket.bucketName,
      description: 'S3 lake bucket name (datasets live under prefixes you define)',
    });

    new cdk.CfnOutput(this, 'LakehouseBucketArn', {
      value: this.bucket.bucketArn,
      description: 'Lake bucket ARN',
    });

    new cdk.CfnOutput(this, 'LakehouseReadOnlyPolicyArn', {
      value: this.readOnlyManagedPolicy.managedPolicyArn,
      description: 'Attach to app IAM roles for read-only lake access',
    });

    new cdk.CfnOutput(this, 'LakehouseReadWritePolicyArn', {
      value: this.readWriteManagedPolicy.managedPolicyArn,
      description: 'Attach to app IAM roles for read/write lake access',
    });
  }
}
