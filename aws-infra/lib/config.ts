import * as cdk from 'aws-cdk-lib';

/** Logical prefix for resource names (override via context: projectName). */
export function projectName(app: cdk.App): string {
  return app.node.tryGetContext('projectName') ?? 'learn-aws';
}

export function stackDescription(kind: string): string {
  return `Learning sandbox — ${kind}`;
}
