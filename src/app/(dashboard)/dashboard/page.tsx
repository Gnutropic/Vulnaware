// @polsia:user-owned
'use client';

import { DashboardMttr } from '@/components/custom/dashboard/dashboard-mttr';
import { DashboardOpenAging } from '@/components/custom/dashboard/dashboard-open-aging';
import { DashboardOpenBySeverity } from '@/components/custom/dashboard/dashboard-open-by-severity';
import { DashboardRecentActivity } from '@/components/custom/dashboard/dashboard-recent-activity';
import { DashboardRecentRemediations } from '@/components/custom/dashboard/dashboard-recent-remediations';
import { DashboardScanCoverage } from '@/components/custom/dashboard/dashboard-scan-coverage';
import { DashboardStatsRow } from '@/components/custom/dashboard/dashboard-stats-row';
import { DashboardTopAssets } from '@/components/custom/dashboard/dashboard-top-assets';
import { DashboardTopCves } from '@/components/custom/dashboard/dashboard-top-cves';
import { DashboardTopCvesByEpss } from '@/components/custom/dashboard/dashboard-top-cves-by-epss';
import { DashboardTrendChart } from '@/components/custom/dashboard/dashboard-trend-chart';
import { CloudConnectionNudge } from '@/components/custom/trial/cloud-connection-nudge';
import { DashboardViewTracker } from '@/components/custom/trial/dashboard-view-tracker';
import { OnboardingChecklistCard } from '@/components/custom/trial/onboarding-checklist-card';
import { Badge } from '@/components/ui/badge';
import { useSession } from '@/lib/auth-client';

function hasRole(role: string | null | undefined, expected: string) {
  return (
    role
      ?.split(',')
      .map((item) => item.trim())
      .includes(expected) ?? false
  );
}

export default function DashboardPage() {
  const { data: session } = useSession();
  const isAdmin = hasRole(session?.user?.role, 'admin');

  return (
    <div className="grid gap-6">
      <OnboardingChecklistCard />
      <DashboardViewTracker />
      <CloudConnectionNudge />
      <section className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-sm font-medium text-muted-foreground">
            {isAdmin ? 'Admin dashboard' : 'Customer dashboard'}
          </p>
          <h1 className="text-h1 font-display tracking-tight text-foreground">Overview</h1>
        </div>
        <Badge variant="secondary" className="w-fit">
          {isAdmin ? 'Admin role' : 'User role'}
        </Badge>
      </section>

      <DashboardStatsRow />
      <DashboardTrendChart />
      <DashboardTopAssets />
      <DashboardOpenBySeverity />
      <DashboardScanCoverage />
      <DashboardMttr />
      <DashboardRecentRemediations />
      <DashboardTopCves />
      <DashboardTopCvesByEpss />
      <DashboardOpenAging />
      <DashboardRecentActivity />
    </div>
  );
}
