// @polsia:user-owned — source-string regression test for the /billing/success
// Server Component. Asserts it (a) exports `metadata`, (b) reads `searchParams`
// (Next 16 Promise), (c) calls verifyCheckoutSession directly (server-side,
// data-plane read), (d) mounts the BillingVerificationPoller island for the
// not-yet-verified branch, (e) renders all three branches (no-session,
// verified, not-verified).

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const PAGE = path.join(process.cwd(), 'src/app/(custom)/billing/success/page.tsx');

describe('/billing/success page', () => {
  it('exists at src/app/(custom)/billing/success/page.tsx', () => {
    expect(existsSync(PAGE)).toBe(true);
  });

  it('exports metadata so the success page ranks and renders with a real title', () => {
    const src = readFileSync(PAGE, 'utf8');
    expect(src).toMatch(/export const metadata(?::\s*Metadata)?\s*=/);
  });

  it('awaits searchParams on the Next 16 Promise shape used by signup/page.tsx', () => {
    const src = readFileSync(PAGE, 'utf8');
    expect(src).toMatch(/searchParams:\s*Promise</);
    expect(src).toMatch(/await\s+searchParams/);
  });

  it('reads session_id off the awaited searchParams and falls back to ""', () => {
    const src = readFileSync(PAGE, 'utf8');
    expect(src).toMatch(/params\.session_id\s*\?\?\s*['"]['"]/);
  });

  it('imports verifyCheckoutSession from @/lib/stripe-billing/client (server-side data plane)', () => {
    const src = readFileSync(PAGE, 'utf8');
    expect(src).toMatch(/verifyCheckoutSession/);
    expect(src).toMatch(/from\s+['"]@\/lib\/stripe-billing\/client['"]/);
  });

  it('mounts the BillingVerificationPoller island for the not-yet-verified branch', () => {
    const src = readFileSync(PAGE, 'utf8');
    expect(src).toMatch(
      /from\s+['"]@\/components\/custom\/billing\/billing-verification-poller['"]/,
    );
    expect(src).toMatch(/<BillingVerificationPoller/);
  });

  it('renders the empty-state branch when no session_id was passed', () => {
    const src = readFileSync(PAGE, 'utf8');
    expect(src).toMatch(/!sessionId/);
    expect(src).toMatch(/Return to pricing/i);
  });

  it('renders the verified branch after initial.verified && initial.payment', () => {
    const src = readFileSync(PAGE, 'utf8');
    expect(src).toMatch(/initial\.verified\s*&&\s*initial\.payment/);
    // The verified panel should display the product name + amount + customer
    // email pulled off the verification result.
    expect(src).toMatch(/product_name/);
    expect(src).toMatch(/amount_usd/);
    expect(src).toMatch(/customer_email/);
  });
});
