// @polsia:user-owned — Unified dispatch for the /api/cloud/discover POST.
// Accepts EITHER a persisted `{provider, connectionId}` pair OR a
// `{provider, credentials}` blob — when credentials are supplied the route
// creates a row in the appropriate *Connection table first, then queues
// a run through the canonical dispatchDiscoveryRun helper so the cron in
// polsia.toml drains it.
//
// Decision: persistent (the new connection row stays). This matches the
// existing per-provider flow and keeps authoring symmetric across every
// entry point. The ephemeral path would need a SECOND orchestrator that
// doesn't write a connection row — substantial new surface area for no
// clear benefit, so we go with the persistent path the brief flags as
// "Recommended".

import 'server-only';
import { dispatchDiscoveryRun } from '@/lib/business/cloud/discovery-schedule';
import type { CloudUnifiedDiscoverRequest } from '@/lib/contracts/cloud-discover';
import { prisma } from '@/lib/db';

export interface DispatchUnifiedDiscoveryParams {
  userId: string;
  body: CloudUnifiedDiscoverRequest;
}

export interface DispatchUnifiedDiscoveryResult {
  provider: 'aws' | 'azure' | 'gcp';
  id: string;
  connectionId: string;
  pollUrl: string;
}

export async function dispatchUnifiedDiscovery(
  params: DispatchUnifiedDiscoveryParams,
): Promise<DispatchUnifiedDiscoveryResult> {
  switch (params.body.provider) {
    case 'aws':
      return dispatchAws(params.userId, params.body);
    case 'azure':
      return dispatchAzure(params.userId, params.body);
    case 'gcp':
      return dispatchGcp(params.userId, params.body);
  }
}

function isAwsConnectionIdRef(
  body: CloudUnifiedDiscoverRequest,
): body is Extract<CloudUnifiedDiscoverRequest, { provider: 'aws'; connectionId: string }> {
  return body.provider === 'aws' && 'connectionId' in body;
}

function isAwsCredentialsPayload(
  body: CloudUnifiedDiscoverRequest,
): body is Extract<CloudUnifiedDiscoverRequest, { provider: 'aws'; roleArn: string }> {
  return body.provider === 'aws' && !('connectionId' in body);
}

function isAzureConnectionIdRef(
  body: CloudUnifiedDiscoverRequest,
): body is Extract<CloudUnifiedDiscoverRequest, { provider: 'azure'; connectionId: string }> {
  return body.provider === 'azure' && 'connectionId' in body;
}

function isAzureCredentialsPayload(
  body: CloudUnifiedDiscoverRequest,
): body is Extract<CloudUnifiedDiscoverRequest, { provider: 'azure'; subscriptionId: string }> {
  return body.provider === 'azure' && !('connectionId' in body);
}

function isGcpConnectionIdRef(
  body: CloudUnifiedDiscoverRequest,
): body is Extract<CloudUnifiedDiscoverRequest, { provider: 'gcp'; connectionId: string }> {
  return body.provider === 'gcp' && 'connectionId' in body;
}

function isGcpCredentialsPayload(
  body: CloudUnifiedDiscoverRequest,
): body is Extract<CloudUnifiedDiscoverRequest, { provider: 'gcp'; projectId: string }> {
  return body.provider === 'gcp' && !('connectionId' in body);
}

async function dispatchAws(
  userId: string,
  body: CloudUnifiedDiscoverRequest,
): Promise<DispatchUnifiedDiscoveryResult> {
  // Narrow by both discriminator + key shape so TS accepts the prop access.
  const isIdRef = isAwsConnectionIdRef(body);
  const isCreds = isAwsCredentialsPayload(body);
  if (!isIdRef && !isCreds) throw new Error('aws dispatch: invalid input shape');

  let connectionId: string;
  let regions: string[];
  if (isIdRef) {
    const conn = await prisma.awsConnection.findFirst({
      where: { id: body.connectionId, userId },
      select: { id: true, regions: true },
    });
    if (!conn) throw new Error('aws connection not found');
    connectionId = conn.id;
    regions = conn.regions;
  } else {
    const created = await prisma.awsConnection.create({
      data: {
        userId,
        roleArn: body.roleArn,
        externalId: body.externalId,
        label: body.label,
        regions: body.regions,
      },
    });
    connectionId = created.id;
    regions = body.regions;
  }
  const queued = await dispatchDiscoveryRun({
    provider: 'aws',
    connectionId,
    userId,
    regions,
  });
  return {
    provider: 'aws',
    id: queued.runId,
    connectionId,
    pollUrl: `/api/cloud/runs/${queued.runId}`,
  };
}

async function dispatchAzure(
  userId: string,
  body: CloudUnifiedDiscoverRequest,
): Promise<DispatchUnifiedDiscoveryResult> {
  const isIdRef = isAzureConnectionIdRef(body);
  const isCreds = isAzureCredentialsPayload(body);
  if (!isIdRef && !isCreds) throw new Error('azure dispatch: invalid input shape');

  let connectionId: string;
  let locations: string[];
  if (isIdRef) {
    const conn = await prisma.azureConnection.findFirst({
      where: { id: body.connectionId, userId },
      select: { id: true, locations: true },
    });
    if (!conn) throw new Error('azure connection not found');
    connectionId = conn.id;
    locations = conn.locations;
  } else {
    const created = await prisma.azureConnection.create({
      data: {
        userId,
        subscriptionId: body.subscriptionId,
        tenantId: body.tenantId,
        clientId: body.clientId,
        clientSecret: body.clientSecret,
        label: body.label,
        locations: body.locations,
      },
    });
    connectionId = created.id;
    locations = body.locations;
  }
  const queued = await dispatchDiscoveryRun({
    provider: 'azure',
    connectionId,
    userId,
    regions: locations,
  });
  return {
    provider: 'azure',
    id: queued.runId,
    connectionId,
    pollUrl: `/api/cloud/runs/${queued.runId}`,
  };
}

async function dispatchGcp(
  userId: string,
  body: CloudUnifiedDiscoverRequest,
): Promise<DispatchUnifiedDiscoveryResult> {
  const isIdRef = isGcpConnectionIdRef(body);
  const isCreds = isGcpCredentialsPayload(body);
  if (!isIdRef && !isCreds) throw new Error('gcp dispatch: invalid input shape');

  let connectionId: string;
  let zones: string[];
  if (isIdRef) {
    const conn = await prisma.gcpConnection.findFirst({
      where: { id: body.connectionId, userId },
      select: { id: true, zones: true },
    });
    if (!conn) throw new Error('gcp connection not found');
    connectionId = conn.id;
    zones = conn.zones;
  } else {
    // We don't re-validate serviceAccountJson here — the per-provider
    // GcpConnectionCreate contract already did. We just normalize before
    // writing.
    const created = await prisma.gcpConnection.create({
      data: {
        userId,
        projectId: body.projectId,
        serviceAccountJson: body.serviceAccountJson,
        label: body.label,
        zones: body.zones,
      },
    });
    connectionId = created.id;
    zones = body.zones;
  }
  const queued = await dispatchDiscoveryRun({
    provider: 'gcp',
    connectionId,
    userId,
    regions: zones,
  });
  return {
    provider: 'gcp',
    id: queued.runId,
    connectionId,
    pollUrl: `/api/cloud/runs/${queued.runId}`,
  };
}
