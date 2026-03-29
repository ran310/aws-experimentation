import * as cdk from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';
import { stackDescription } from '../config';

export interface HttpApiStackProps extends cdk.StackProps {
  readonly projectName: string;
}

/**
 * Sample serverless API: HTTP API + Lambda (no VPC). For a richer UI see aws-infra-dashboard.
 */
export class HttpApiStack extends cdk.Stack {
  public readonly httpApi: apigwv2.HttpApi;
  public readonly handler: lambda.Function;

  constructor(scope: Construct, id: string, props: HttpApiStackProps) {
    super(scope, id, {
      ...props,
      description: stackDescription('HTTP API + Lambda sample'),
    });

    const { projectName } = props;

    this.handler = new lambda.Function(this, 'ApiHandler', {
      functionName: `${projectName}-http-api`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      timeout: cdk.Duration.seconds(10),
      code: lambda.Code.fromInline(`
exports.handler = async (event) => {
  const body = {
    message: 'Hello from Lambda',
    path: event.rawPath,
    method: event.requestContext?.http?.method,
    time: new Date().toISOString(),
  };
  return { statusCode: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
};
`),
    });

    this.httpApi = new apigwv2.HttpApi(this, 'HttpApi', {
      apiName: `${projectName}-http-api`,
      description: 'Sandbox HTTP API sample',
      defaultIntegration: new integrations.HttpLambdaIntegration('DefaultIntegration', this.handler),
    });

    new cdk.CfnOutput(this, 'HttpApiUrl', {
      value: this.httpApi.apiEndpoint,
      description: 'Base URL for the HTTP API',
    });
  }
}
