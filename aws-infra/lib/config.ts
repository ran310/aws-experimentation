import * as cdk from 'aws-cdk-lib';

/** Logical prefix for resource names (override via context: projectName). */
export function projectName(app: cdk.App): string {
  return app.node.tryGetContext('projectName') ?? 'learn-aws';
}

/**
 * When set via context key `publicAlbHttps`, the EC2 stack provisions ACM (DNS validation),
 * an internet-facing ALB (TLS), Route 53 aliases, and restricts nginx :80 to the ALB only.
 * No Certbot or SSH required; destroy/recreate is fully CDK-driven.
 *
 * @see README "Managed HTTPS (ACM + ALB)"
 */
export interface PublicAlbHttpsContext {
  readonly hostedZoneId: string;
  readonly zoneName: string;
  /** Primary name on the ACM certificate (usually the apex, e.g. ram-narayanan.com). */
  readonly certificateDomainName: string;
  /** Extra names on the cert (e.g. www.ram-narayanan.com, nfl-quiz.ram-narayanan.com). */
  readonly subjectAlternativeNames?: string[];
  /**
   * Route 53 A alias labels under zoneName. Use "" or omit apex handling via auto-derivation.
   * If omitted, alias records are created for certificateDomainName + subjectAlternativeNames.
   */
  readonly aliasNames?: string[];
}

/**
 * Optional exact S3 bucket name for the lakehouse stack (must be globally unique).
 * If unset, the bucket is named `mylakehouse-{account}-{region}`.
 */
export function lakehouseBucketNameFromContext(app: cdk.App): string | undefined {
  const v = app.node.tryGetContext('lakehouseBucketName');
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}

export function publicAlbHttpsConfig(app: cdk.App): PublicAlbHttpsContext | undefined {
  let c = app.node.tryGetContext('publicAlbHttps') as PublicAlbHttpsContext | string | undefined;
  if (c == null) {
    return undefined;
  }
  if (typeof c === 'string') {
    try {
      c = JSON.parse(c) as PublicAlbHttpsContext;
    } catch {
      return undefined;
    }
  }
  if (!c?.hostedZoneId || !c?.zoneName || !c?.certificateDomainName) {
    return undefined;
  }
  return c;
}

export function stackDescription(kind: string): string {
  return `Learning sandbox — ${kind}`;
}

/** Relative Route 53 record name under zone ("" = apex). */
export function fqdnToRelativeRecordName(fqdn: string, zoneName: string): string {
  const z = zoneName.replace(/\.$/, '');
  const f = fqdn.replace(/\.$/, '');
  if (f === z) {
    return '';
  }
  const suffix = `.${z}`;
  if (!f.endsWith(suffix)) {
    throw new Error(`Domain "${fqdn}" is not under hosted zone "${zoneName}"`);
  }
  return f.slice(0, -suffix.length);
}
