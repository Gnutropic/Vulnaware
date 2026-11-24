// @polsia:user-owned — anonymous browser journey for the public changelog.
import { expect, test } from '@playwright/test';

const UPDATES = [
  {
    id: 'resolved-alert-filter',
    title: 'Resolved-alert filter',
    body: 'Filter the alert list to resolved alerts.',
  },
  {
    id: 'asset-risk-score-trend',
    title: 'Asset risk-score trend',
    body: 'View an asset’s risk score over time.',
  },
  {
    id: 'dashboard-tiles',
    title: 'Dashboard tiles',
    body: 'Review product information in dashboard tiles.',
  },
  { id: 'pdf-export', title: 'PDF export', body: 'Export as a PDF.' },
  {
    id: 'snooze-summary-email-digest',
    title: 'Snooze-summary email digest',
    body: 'Receive an email digest summarizing snoozed alerts.',
  },
];

for (const viewport of [
  { name: 'desktop', width: 1440, height: 1000 },
  { name: 'mobile', width: 390, height: 844 },
]) {
  test(`public changelog is reachable through navigation on ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });

    const publicApiResponse = await page.request.get('/api/changelog');
    expect(publicApiResponse.status()).toBe(200);
    const payload = await publicApiResponse.json();
    expect(payload.entries).toEqual(UPDATES);
    expect(payload.entries.every((entry: Record<string, unknown>) => !('date' in entry))).toBe(
      true,
    );

    await page.goto('/pricing');
    if (viewport.name === 'mobile') {
      await page.getByRole('button', { name: 'Open menu' }).click();
      await page.getByRole('navigation', { name: 'Mobile' }).getByRole('link', {
        name: 'Changelog',
        exact: true,
      }).click();
    } else {
      await page.getByRole('button', { name: 'More' }).click();
      await page.getByRole('menuitem', { name: 'Changelog', exact: true }).click();
    }

    await expect(page).toHaveURL(/\/changelog$/);
    for (const update of UPDATES) {
      const entry = page.locator(`#entry-${update.id}`);
      await expect(entry).toBeVisible();
      await expect(entry.getByRole('heading', { name: update.title })).toBeVisible();
      await expect(entry).toContainText(update.body);
      await expect(entry.getByText('Shipped', { exact: true })).toBeVisible();
    }

    await expect(page.locator('time')).toHaveCount(0);
    expect(await page.evaluate(() => window.innerWidth)).toBe(viewport.width);
  });
}
