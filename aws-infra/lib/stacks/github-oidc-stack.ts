import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { stackDescription } from '../config';

export interface GitHubOidcStackProps extends cdk.StackProps {
  readonly projectName: string;
  /**
   * GitHub user / org that owns all the repos deploying to this AWS account.
   * The trust policy is scoped to `repo:<githubOwner>/*` — every repo under
   * this owner can assume the role, but only if the workflow is running on
   * the `main` branch (enforced by the `sub` condition below).
   */
  readonly githubOwner: string;
  /**
   * The S3 bucket that holds deployment artifacts. Passed in from
   * Ec2NginxStack so this stack does not need to know the bucket name.
   */
  readonly artifactBucket: s3.IBucket;
}

/**
 * IAM role for GitHub Actions workflows. Uses OIDC federation (no long-lived
 * access keys) scoped to a specific GitHub owner.
 *
 * Permissions granted:
 *  - cloudformation:DescribeStacks — read stack outputs in every deploy workflow
 *  - s3:PutObject on the artifact bucket — upload release bundles
 *  - ssm:SendCommand + GetCommandInvocation — optional SSM admin / legacy scripts
 *  - codedeploy:* — CodeDeploy deploys for all nginx app repos
 *
 * The role ARN is emitted as a CloudFormation output; copy it into the
 * `AWS_ROLE_TO_ASSUME` secret in every GitHub repo that deploys to this account.
 */
export class GitHubOidcStack extends cdk.Stack {
  public readonly role: iam.Role;

  constructor(scope: Construct, id: string, props: GitHubOidcStackProps) {
    super(scope, id, {
      ...props,
      description: stackDescription('GitHub Actions OIDC federation role'),
    });

    const { githubOwner, artifactBucket, projectName } = props;

    // The GitHub OIDC provider is a singleton per AWS account — one provider
    // serves every repo / workflow. We reference it by ARN rather than
    // creating it so this stack is safe to deploy even if the provider was
    // previously created manually in the console.
    const oidcProvider = iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
      this,
      'GitHubOidcProvider',
      `arn:aws:iam::${cdk.Aws.ACCOUNT_ID}:oidc-provider/token.actions.githubusercontent.com`,
    );

    this.role = new iam.Role(this, 'GitHubActionsRole', {
      roleName: `${projectName}-github-actions`,
      description: 'Assumed by GitHub Actions via OIDC; no long-lived credentials',
      assumedBy: new iam.WebIdentityPrincipal(oidcProvider.openIdConnectProviderArn, {
        // aud must be sts.amazonaws.com when using aws-actions/configure-aws-credentials v2+
        StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
        },
        // Scope to main-branch pushes and workflow_dispatch on any repo
        // owned by githubOwner. Tighten to a specific repo by replacing
        // the wildcard: `repo:${githubOwner}/my-repo:ref:refs/heads/main`
        StringLike: {
          'token.actions.githubusercontent.com:sub': `repo:${githubOwner}/*:*`,
        },
      }),
    });

    // ── CloudFormation ────────────────────────────────────────────────────
    // Every deploy workflow reads stack outputs (bucket names, instance IDs,
    // CodeDeploy app/DG names) via `aws cloudformation describe-stacks`.
    this.role.addToPolicy(new iam.PolicyStatement({
      sid: 'CfnReadOutputs',
      actions: ['cloudformation:DescribeStacks'],
      resources: ['*'],
    }));

    // ── S3 artifact uploads ───────────────────────────────────────────────
    // project-showcase, aws-health-dashboard, etc. all upload release
    // bundles here before triggering the deploy mechanism.
    artifactBucket.grantPut(this.role);

    // ── SSM remote execution ──────────────────────────────────────────────
    // project-showcase (and other SSM-based apps) run their remote-install.sh
    // via AWS-RunShellScript. GetCommandInvocation polls for the result.
    this.role.addToPolicy(new iam.PolicyStatement({
      sid: 'SsmRemoteDeploy',
      actions: [
        'ssm:SendCommand',
        'ssm:GetCommandInvocation',
      ],
      resources: ['*'],
    }));

    // ── CodeDeploy ────────────────────────────────────────────────────────
    // Deploy workflows: upload revision, create deployment, wait for success.
    // ListDeployments is required for the "wait until deployment group idle" step
    // (aws deploy list-deployments in GitHub Actions).
    this.role.addToPolicy(new iam.PolicyStatement({
      sid: 'CodeDeployPush',
      actions: [
        'codedeploy:RegisterApplicationRevision',
        'codedeploy:CreateDeployment',
        'codedeploy:GetDeployment',
        'codedeploy:GetDeploymentConfig',
        'codedeploy:GetApplicationRevision',
        'codedeploy:ListDeployments',
      ],
      resources: ['*'],
    }));

    new cdk.CfnOutput(this, 'GitHubActionsRoleArn', {
      value: this.role.roleArn,
      description: 'Set as AWS_ROLE_TO_ASSUME secret in every GitHub repo that deploys here',
    });
  }
}
