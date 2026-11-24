// @polsia:user-owned — regression test for the legal pages. If /privacy or
// /terms is accidentally dropped (page file deleted, or nav entry removed), one
// of these `it` blocks fails. The footer-strip order block also catches
// half-step collision if someone re-sorts the nav array.

import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { type NavItem, navItems } from '../../src/lib/nav';

const REPO_ROOT = process.cwd();
const PRIVACY_PAGE = path.join(REPO_ROOT, 'src/app/(custom)/privacy/page.tsx');
const TERMS_PAGE = path.join(REPO_ROOT, 'src/app/(custom)/terms/page.tsx');

const footerItems = (): NavItem[] =>
  navItems.filter((item) => item.group === 'footer' && typeof item.order === 'number');

describe('legal pages', () => {
  it("'/privacy' and '/terms' render via Server Component page files", () => {
    expect(existsSync(PRIVACY_PAGE)).toBe(true);
    expect(existsSync(TERMS_PAGE)).toBe(true);
  });

  it("'navItems' exposes /privacy and /terms in the footer group", () => {
    const items = footerItems();
    expect(items.some((i) => i.href === '/privacy')).toBe(true);
    expect(items.some((i) => i.href === '/terms')).toBe(true);
  });

  it('footer strip order places Privacy between FAQ and Blog, Terms between Blog and About', () => {
    const items = footerItems();
    const byHref = (href: string): number => {
      const found = items.find((i) => i.href === href);
      if (!found || typeof found.order !== 'number') {
        throw new Error(`footer item ${href} missing or has no order`);
      }
      return found.order;
    };

    const faq = byHref('/faq');
    const blog = byHref('/blog');
    const about = byHref('/about');
    const privacy = byHref('/privacy');
    const terms = byHref('/terms');

    expect(privacy).toBeGreaterThan(faq);
    expect(privacy).toBeLessThan(blog);
    expect(terms).toBeGreaterThan(blog);
    expect(terms).toBeLessThan(about);
  });
});
