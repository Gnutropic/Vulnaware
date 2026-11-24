// @polsia:user-owned — typed seed for the public /changelog page.
//
// This is a marketing artifact, not a DB diary: entries are authored here and
// served through /api/changelog. Keep the order in this file as the displayed
// order, and use stable date-free IDs for anchors and React keys.

export interface ChangelogEntry {
  id: string;
  title: string;
  body: string;
}

export const CHANGELOG_ENTRIES: ChangelogEntry[] = [
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
  {
    id: 'pdf-export',
    title: 'PDF export',
    body: 'Export as a PDF.',
  },
  {
    id: 'snooze-summary-email-digest',
    title: 'Snooze-summary email digest',
    body: 'Receive an email digest summarizing snoozed alerts.',
  },
];
