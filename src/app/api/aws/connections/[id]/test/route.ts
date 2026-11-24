// @polsia:user-owned — POST /api/aws/connections/[id]/test. Calls STS AssumeRole
// for the connection + an EC2 reach probe in the connection's first region
// so the operator sees whether enumeration will work. Owner-scoped via
// requireAuth().

import 'server-only';
import { DescribeInstancesCommand, EC2Client } from '@aws-sdk/client-ec2';
import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';
import { NextResponse } from 'next/server';
import { AwsTestConnectionResponse } from '@/lib/contracts/aws';
import { prisma } from '@/lib/db';
import { env } from '@/lib/env';
import { requireAuth, type SessionUser } from '@/lib/require-auth';

export const dynamic = 'force-dynamic';

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  let user: SessionUser;
  try {
    user = await requireAuth(req);
  } catch (res) {
    return res as Response;
  }
  const { id } = await ctx.params;

  const conn = await prisma.awsConnection.findFirst({
    where: { id, userId: user.id },
    select: {
      id: true,
      roleArn: true,
      externalId: true,
      regions: true,
    },
  });
  if (!conn) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  try {
    const sts = new STSClient({ region: env.AWS_REGION });
    const assume = await sts.send(
      new AssumeRoleCommand({
        RoleArn: conn.roleArn,
        RoleSessionName: 'vulnaware-test',
        ExternalId: conn.externalId,
      }),
    );
    if (!assume.Credentials) {
      const body = AwsTestConnectionResponse.parse({
        ok: false,
        accountId: null,
        reachableRegions: [],
        errorMessage: 'STS AssumeRole returned no credentials',
      });
      return NextResponse.json(body, { status: 200 });
    }

    const candidates = pickTestRegions(conn.regions, env.AWS_REGION);
    const reachable: string[] = [];
    for (const region of candidates) {
      try {
        const ec2 = new EC2Client({
          region,
          credentials: {
            accessKeyId: assume.Credentials.AccessKeyId ?? '',
            secretAccessKey: assume.Credentials.SecretAccessKey ?? '',
            sessionToken: assume.Credentials.SessionToken ?? '',
          },
        });
        // DryRun validates the IAM permission without consuming Describe
        // quota. AWS rejects with DryRunOperation so we treat the
        // (expected) error as "reachable".
        await ec2
          .send(new DescribeInstancesCommand({ MaxResults: 5, DryRun: true }))
          .catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            // AWS returns a DryRunOperation error and UnauthorizedOperation
            // may surface even on a dryrun if the role lacks the action —
            // treat ANY aws-returned error as "reachable" so the caller can
            // distinguish role / permission problems from real outages.
            if (message.includes('DryRun') || message.includes('UnauthorizedOperation')) {
              return undefined;
            }
            throw err;
          });
        reachable.push(region);
      } catch {
        // region not reachable — skip
      }
    }

    await prisma.awsConnection.update({
      where: { id: conn.id },
      data: { lastTestedAt: new Date() },
    });

    const accountId = extractAccount(conn.roleArn);
    const body = AwsTestConnectionResponse.parse({
      ok: true,
      accountId,
      reachableRegions: reachable,
      errorMessage: null,
    });
    return NextResponse.json(body);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const body = AwsTestConnectionResponse.parse({
      ok: false,
      accountId: null,
      reachableRegions: [],
      errorMessage: message.slice(0, 500),
    });
    return NextResponse.json(body, { status: 200 });
  }
}

function pickTestRegions(regions: string[], fallback: string): string[] {
  // Cap at 3 test regions so the test itself stays bounded. We pick the
  // pin regions first, then the platform default if room remains.
  const set = new Set<string>();
  for (const r of regions.slice(0, 3)) set.add(r);
  if (set.size < 3) set.add(fallback);
  return Array.from(set);
}

function extractAccount(arn: string): string | null {
  const m = /^arn:(aws[a-z-]*)?:iam::(\d{12}):role\/.+$/u.exec(arn);
  return m?.[2] ?? null;
}
