// @polsia:user-owned — app navigation rendered by SiteNav/SiteFooter and read by
// the sitemap. Edit it as pages are added or removed.
// This list is a convenience, not module registration.

export type NavGroup = 'primary' | 'secondary' | 'footer';

export interface NavItem {
  /** Visible link text. */
  label: string;
  /** App route, e.g. '/' or '/dashboard'. */
  href: string;
  /** Where it renders: top-nav 'primary'/'secondary', or 'footer'. */
  group: NavGroup;
  /** Group `primary` items into a dropdown: items sharing a `menu` value collapse
   *  into one "<menu> ⌄" top-bar slot (e.g. `menu: 'Resources'` on Blog/Docs/
   *  Changelog). Keeps the bar short. Ignored for 'secondary'/'footer'. */
  menu?: string;
  /** When true, render only if a session exists (see site-nav.tsx). */
  requiresAuth?: boolean;
  /** Sort key within a group (ascending); unordered items fall to the end. */
  order?: number;
}

// Keep the bar short: ~3-5 primary slots, group the tail with `menu`, push the
// rest to 'footer' (SiteNav overflows extras into a "More" dropdown). Example:
//   { label: 'Pricing', href: '/pricing', group: 'primary' },
//   { label: 'Blog',    href: '/blog',    group: 'primary', menu: 'Resources' },
//   { label: 'Docs',    href: '/docs',    group: 'primary', menu: 'Resources' },
//   { label: 'Sign in', href: '/login',   group: 'secondary' },
export const navItems: NavItem[] = [
  { label: 'Capabilities', href: '/#capabilities', group: 'primary', order: 1 },
  { label: 'How it works', href: '/#workflow', group: 'primary', order: 2 },
  { label: 'Severity model', href: '/#severity', group: 'primary', order: 3 },
  { label: 'FAQ', href: '/#faq', group: 'primary', order: 4 },
  { label: 'Pricing', href: '/pricing', group: 'primary', order: 5 },
  { label: 'Sign up', href: '/signup', group: 'primary', order: 5.2 },
  { label: 'About', href: '/about', group: 'primary', order: 5.5 },
  { label: 'Scans', href: '/scans', group: 'primary', order: 6 },
  {
    label: 'Cloud',
    href: '/cloud',
    group: 'primary',
    requiresAuth: true,
    order: 7,
  },
  {
    label: 'Blog',
    href: '/blog',
    group: 'primary',
    menu: 'Resources',
    order: 7.5,
  },
  {
    label: 'Changelog',
    href: '/changelog',
    group: 'primary',
    menu: 'Resources',
    order: 7.6,
  },
  {
    label: 'Team',
    href: '/settings/team',
    group: 'primary',
    menu: 'Settings',
    requiresAuth: true,
    order: 9,
  },
  {
    label: 'API keys',
    href: '/settings/api-keys',
    group: 'primary',
    menu: 'Settings',
    requiresAuth: true,
    order: 10,
  },
  {
    label: 'Compliance',
    href: '/compliance',
    group: 'primary',
    menu: 'Settings',
    requiresAuth: true,
    order: 11,
  },
  {
    label: 'CI/CD integrations',
    href: '/settings/integrations/ci-cd',
    group: 'primary',
    menu: 'Settings',
    requiresAuth: true,
    order: 12,
  },
  {
    label: 'Notifications',
    href: '/settings/integrations/notifications',
    group: 'primary',
    menu: 'Settings',
    requiresAuth: true,
    order: 12.5,
  },
  {
    label: 'Intel',
    href: '/settings/intel',
    group: 'primary',
    menu: 'Settings',
    requiresAuth: true,
    order: 13,
  },
  { label: 'Contact', href: '/contact', group: 'secondary', order: 0 },
  { label: 'Start free trial', href: '/#trial', group: 'secondary', order: -1 },
  { label: 'Security', href: '/security', group: 'footer', order: -4 },
  { label: 'Pricing', href: '/pricing', group: 'footer', order: -3 },
  { label: 'FAQ', href: '/faq', group: 'footer', order: -2 },
  { label: 'Privacy', href: '/privacy', group: 'footer', order: -1.5 },
  { label: 'Blog', href: '/blog', group: 'footer', order: -1 },
  { label: 'Terms', href: '/terms', group: 'footer', order: -0.5 },
  { label: 'About', href: '/about', group: 'footer', order: 0 },
];
