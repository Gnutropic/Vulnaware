// @polsia:user-owned — GET /api/v1/docs.
// Returns an HTML page embedding Swagger UI (loaded from jsDelivr CDN,
// swagger-ui-dist@5) pointing at /api/v1/openapi.json. No auth required.

import 'server-only';
import { brand } from '@/lib/brand';
import { withRateLimit } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

function buildDocsHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${brand.name} API Docs</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css" />
  <style>
    body { margin: 0; background: #0a1313; }
    .swagger-ui .topbar { display: none; }
  </style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>
    window.onload = function () {
      SwaggerUIBundle({
        url: '/api/v1/openapi.json',
        dom_id: '#swagger-ui',
        presets: [SwaggerUIBundle.presets.apis, SwaggerUIBundle.SwaggerUIStandalonePreset],
        layout: 'BaseLayout',
        deepLinking: true,
        tryItOutEnabled: true,
      });
    };
  </script>
</body>
</html>`;
}

export async function GET(req: Request) {
  return withRateLimit(req, () =>
    Promise.resolve(
      new Response(buildDocsHtml(), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      }),
    ),
  );
}
