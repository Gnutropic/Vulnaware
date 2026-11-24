// @polsia:user-owned — Role permission primitives. Pure-logic test against the
// ROLE_RANK / hasAtLeast contract in @/lib/permissions/roles so a drift in
// rank ordering surfaces in CI instead of as a 403/role bug.
import { describe, expect, it } from 'vitest';
import { hasAtLeast, ROLE_RANK } from '@/lib/permissions/roles';

describe('Role rank', () => {
  it('viewer < member < admin', () => {
    expect(ROLE_RANK.viewer).toBeLessThan(ROLE_RANK.member);
    expect(ROLE_RANK.member).toBeLessThan(ROLE_RANK.admin);
  });

  it('hasAtLeast satisfies the rank ordering', () => {
    expect(hasAtLeast('admin', 'viewer')).toBe(true);
    expect(hasAtLeast('admin', 'member')).toBe(true);
    expect(hasAtLeast('admin', 'admin')).toBe(true);

    expect(hasAtLeast('member', 'viewer')).toBe(true);
    expect(hasAtLeast('member', 'member')).toBe(true);
    expect(hasAtLeast('member', 'admin')).toBe(false);

    expect(hasAtLeast('viewer', 'viewer')).toBe(true);
    expect(hasAtLeast('viewer', 'member')).toBe(false);
    expect(hasAtLeast('viewer', 'admin')).toBe(false);
  });

  it('rejects null / missing / malformed roles', () => {
    expect(hasAtLeast(null, 'viewer')).toBe(false);
    expect(hasAtLeast(undefined, 'viewer')).toBe(false);
    expect(hasAtLeast('guest', 'viewer')).toBe(false);
  });
});
