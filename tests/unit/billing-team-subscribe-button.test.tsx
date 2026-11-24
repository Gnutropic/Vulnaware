// @polsia:user-owned — source-string regression test for the Team-plan
// Subscribe CTA client island. Asserts it (a) is a 'use client' module,
// (b) imports apiFetch from the shared client, (c) posts to
// /api/billing/team-subscribe on click, (d) navigates via
// window.location.assign on success so the cross-origin redirect survives.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const BUTTON = path.join(process.cwd(), 'src/components/custom/billing/team-subscribe-button.tsx');

describe('TeamSubscribeButton client island', () => {
  it('exists at src/components/custom/billing/team-subscribe-button.tsx', () => {
    expect(existsSync(BUTTON)).toBe(true);
  });

  it('declares "use client" as the first non-comment line so it ships as a client bundle', () => {
    const src = readFileSync(BUTTON, 'utf8');
    // Strip leading // comments + any blank line before the directive so the
    // assertion isn't fooled by the auto-fixed banner above it.
    const stripped = src.replace(/^(\s*\/\/[^\n]*\n)+/, '').replace(/^\s*\n/, '');
    expect(stripped.startsWith("'use client'")).toBe(true);
  });

  it('imports apiFetch from @/lib/api-client so data stays on the typed data plane', () => {
    const src = readFileSync(BUTTON, 'utf8');
    expect(src).toMatch(/from\s+['"]@\/lib\/api-client['"]/);
    expect(src).toMatch(/\bapiFetch\b/);
  });

  it('imports the team-subscribe request + response contract from @/lib/contracts/billing', () => {
    const src = readFileSync(BUTTON, 'utf8');
    expect(src).toMatch(/from\s+['"]@\/lib\/contracts\/billing['"]/);
    expect(src).toMatch(/teamSubscribeRequestSchema/);
    expect(src).toMatch(/teamSubscribeResponseSchema/);
  });

  it('posts to /api/billing/team-subscribe via apiFetch on click', () => {
    const src = readFileSync(BUTTON, 'utf8');
    expect(src).toMatch(/\/api\/billing\/team-subscribe/);
    expect(src).toMatch(/method:\s*'POST'/);
  });

  it('navigates to Stripe via window.location.assign on success', () => {
    const src = readFileSync(BUTTON, 'utf8');
    expect(src).toMatch(/window\.location\.assign\(/);
  });

  it('renders a role="alert" element when checkout fails', () => {
    const src = readFileSync(BUTTON, 'utf8');
    expect(src).toContain('role="alert"');
  });
});
