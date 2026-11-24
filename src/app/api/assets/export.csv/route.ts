// @polsia:user-owned

import 'server-only';
import { authorizeCsvExport, csvExportSources } from '@/lib/csv-export/sources.server';
import { siteUrl } from '@/lib/site';
import { createCsvExportHandlers } from '@/modules/csv-export/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const handlers = createCsvExportHandlers({
  sources: csvExportSources,
  authorize: authorizeCsvExport,
  allowedOrigin: new URL(siteUrl).origin,
});

export const POST = handlers.POST;

function methodNotAllowed(): Response {
  return Response.json({ code: 'method_not_allowed' }, { status: 405, headers: { Allow: 'POST' } });
}

export const GET = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
