// @polsia:user-owned — Top-level cloud-discovery barrel. Re-exports the
// public surface for multi-cloud asset discovery + dispatch. Pure module —
// no server-only imports so callers should import lazily inside an /api route
// handler if they need orchestrators that touch @/lib/db.
//
// The brief asks for asset discovery in src/lib/cloud/. Rather than MOVE
// ~24 existing user-owned files (every header comment, cron import, and
// Prisma model key references their current paths), this file is a thin
// re-export over the canonical locations: src/lib/business/cloud/...
// and src/lib/business/scanner/{aws,azure,gcp}-discovery/...

export {
  type DispatchDiscoveryRunParams,
  type DispatchDiscoveryRunResult,
  dispatchDiscoveryRun,
} from '@/lib/business/cloud/discovery-schedule';

export { dispatchUnifiedDiscovery } from '@/lib/business/cloud/unified-dispatch';

export {
  type RunAwsDiscoveryParams,
  runAwsDiscovery,
} from '@/lib/business/scanner/aws-discovery/run-aws-discovery';
export {
  type RunAzureDiscoveryParams,
  runAzureDiscovery,
} from '@/lib/business/scanner/azure-discovery/run-azure-discovery';
export {
  type RunGcpDiscoveryParams,
  runGcpDiscovery,
} from '@/lib/business/scanner/gcp-discovery/run-gcp-discovery';

export type {
  CloudDiscoveryResponse,
  CloudEnvironmentItem,
  CloudEnvironmentsList,
  CloudNormalizedAssetItem,
  CloudNormalizedAssetList,
  CloudUnifiedDiscoverRequest,
} from '@/lib/contracts/cloud-discover';
