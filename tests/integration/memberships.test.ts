// @polsia:user-owned — Cross-team scope assertion. Verifies that the scan
// routes scope their Prisma queries by teamId and reject cross-team reads
// with 403 (not 404, which leaks existence). We assert against the route
// sources rather than driving a real DB — this keeps the assertion in a
// lint-permitting test path without an `@/lib/db` import that would trip
// biome's noRestrictedImports rule.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');

describe('Per-team scan scoping', () => {
  it('/api/scan GET scopes findMany by teamId', () => {
    const src = readFileSync(resolve(root, 'src/app/api/scan/route.ts'), 'utf8');
    expect(src).toMatch(/prisma\.scan\.findMany\(/);
    expect(src).toContain('where: { teamId: ctx.membership.teamId }');
  });

  it('/api/scan POST stamps the new scan with my teamId', () => {
    const src = readFileSync(resolve(root, 'src/app/api/scan/route.ts'), 'utf8');
    expect(src).toMatch(/runScan\([^,]+,\s*\{\s*teamId:\s*ctx\.membership\.teamId\s*\}\)/);
  });

  it('/api/scan POST requires member role (gates with requireTeamRole)', () => {
    const src = readFileSync(resolve(root, 'src/app/api/scan/route.ts'), 'utf8');
    expect(src).toMatch(/requireTeamRole\(\s*['"]member['"]\s*\)/);
  });

  it('/api/scan [id] rejects cross-team with 403 (NEVER 404 after auth)', () => {
    const src = readFileSync(resolve(root, 'src/app/api/scan/[id]/route.ts'), 'utf8');
    expect(src).toMatch(/scan\.teamId\s*!==\s*ctx\.membership\.teamId/);
    expect(src).toMatch(/status:\s*403/);
    // Make sure we don't accidentally leak existence.
    expect(src).not.toMatch(/status:\s*404/);
  });

  it('/api/scan [id] gates with requireTeamRead before findUnique', () => {
    const src = readFileSync(resolve(root, 'src/app/api/scan/[id]/route.ts'), 'utf8');
    expect(src).toMatch(/requireTeamRead\(\)/);
    expect(src.indexOf('requireTeamRead()')).toBeLessThan(src.indexOf('prisma.scan.findUnique'));
  });
});
