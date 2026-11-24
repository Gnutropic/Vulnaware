// @polsia:user-owned — Redirect-gate wiring for /scans + /cloud/runs/[id].
// Verifies the gate's source files contain the expected redirect bindings
// and the SignInForm honors the `?next=` round-trip. The actual 302 behavior
// is best confirmed by running a dev server and curling the routes; this
// test catches regressions where the gate wiring is accidentally deleted.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');

describe('Auth redirect wiring', () => {
  it('(custom)/scans/layout.tsx redirects anon to /login?next=/scans', () => {
    const src = readFileSync(resolve(root, 'src/app/(custom)/scans/layout.tsx'), 'utf8');
    expect(src).toMatch(/redirect\(['"]\/login\?next=\/scans['"]\)/);
    expect(src).toMatch(/getSessionUser/);
  });

  it('(custom)/cloud/runs/[id]/page.tsx redirects anon to /login?next=/cloud/runs/<id>', () => {
    const src = readFileSync(resolve(root, 'src/app/(custom)/cloud/runs/[id]/page.tsx'), 'utf8');
    expect(src).toMatch(/getSessionUser/);
    expect(src).toMatch(/redirect/);
    expect(src).toContain('/login?next=/cloud/runs/');
    expect(src).toContain('${id}');
  });

  it('SignInForm honors ?next= on success', () => {
    const src = readFileSync(resolve(root, 'src/components/custom/sign-in-form.tsx'), 'utf8');
    expect(src).toMatch(/useSearchParams/);
    expect(src).toMatch(/window\.location\.assign\(next \?\? '\/'/);
  });
});
