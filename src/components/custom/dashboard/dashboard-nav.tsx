// @polsia:user-owned
'use client';

import { Bell, KeyRound, LayoutDashboard, Mail, Server, ShieldCheck, Users } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useIsAdmin } from '@/lib/auth-client';
import { cn } from '@/lib/utils';

const PRIMARY_ITEMS = [
  {
    href: '/dashboard',
    label: 'Overview',
    icon: LayoutDashboard,
    adminOnly: false,
  },
  {
    href: '/alerts',
    label: 'Alerts',
    icon: Bell,
    adminOnly: false,
  },
  {
    href: '/assets',
    label: 'Assets',
    icon: Server,
    adminOnly: false,
  },
];

// Admin-only secondary entries. /settings/api-keys and /settings/team are
// restricted to admins in their own way; /compliance is a compliance / audit
// artifact and is gated admin on the server too (see /api/compliance).
const ADMIN_ITEMS = [
  {
    href: '/settings/api-keys',
    label: 'API keys',
    icon: KeyRound,
  },
  {
    href: '/settings/team',
    label: 'Team',
    icon: Users,
  },
  {
    href: '/compliance',
    label: 'Compliance',
    icon: ShieldCheck,
  },
  {
    href: '/admin/digest',
    label: 'Digest',
    icon: Mail,
  },
];

export function DashboardNav() {
  const pathname = usePathname();
  const isAdmin = useIsAdmin();

  return (
    <nav
      aria-label="Dashboard"
      className="flex gap-2 overflow-x-auto pb-1 lg:grid lg:overflow-visible lg:pb-0"
    >
      {PRIMARY_ITEMS.map((item) => {
        const Icon = item.icon;
        const active = pathname === item.href;

        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'flex h-10 shrink-0 items-center gap-2 rounded-md px-3 text-sm font-medium transition-colors',
              active
                ? 'bg-secondary text-secondary-foreground'
                : 'text-muted-foreground hover:bg-secondary/70 hover:text-foreground',
            )}
          >
            <Icon aria-hidden="true" className="size-4" />
            <span>{item.label}</span>
          </Link>
        );
      })}

      {isAdmin
        ? ADMIN_ITEMS.map((item) => {
            const Icon = item.icon;
            const active = pathname === item.href || pathname.startsWith(`${item.href}/`);

            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex h-10 shrink-0 items-center gap-2 rounded-md px-3 text-sm font-medium transition-colors',
                  active
                    ? 'bg-secondary text-secondary-foreground'
                    : 'text-muted-foreground hover:bg-secondary/70 hover:text-foreground',
                )}
              >
                <Icon aria-hidden="true" className="size-4" />
                <span>{item.label}</span>
              </Link>
            );
          })
        : null}
    </nav>
  );
}
