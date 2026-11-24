import { describe, expect, it } from 'vitest';
import {
  buildAlertRemediationPrompt,
  missingAlertRemediationContext,
  normalizeAlertRemediationOutput,
} from '@/lib/business/alert-remediation-guidance';

const context = {
  cveId: 'CVE-2025-0001',
  description: 'A vulnerability in the exposed service allows unauthorized access.',
  cvssScore: 8.1,
  severity: 'high',
  source: 'kev' as const,
  asset: { host: 'edge.example.com', ip: '203.0.113.10', port: 443, protocol: 'tcp' },
};

describe('alert remediation guidance', () => {
  it('requires a real CVE and a vulnerability description', () => {
    expect(missingAlertRemediationContext({ cveId: 'UNKNOWN', description: '' })).toEqual([
      'cve',
      'description',
    ]);
    expect(missingAlertRemediationContext({ cveId: 'CVE-2025-0001', description: '  details ' })).toEqual(
      [],
    );
  });

  it('delimits supplied alert values and excludes seed or note context', () => {
    const prompt = buildAlertRemediationPrompt(context);
    expect(prompt.user).toContain('<cve_id>CVE-2025-0001</cve_id>');
    expect(prompt.user).toContain('<description>A vulnerability in the exposed service allows unauthorized access.</description>');
    expect(prompt.user).toContain('203.0.113.10');
    expect(prompt.user).not.toContain('recommendedFix');
    expect(prompt.user).not.toContain('Recent notes');
    expect(prompt.system).toContain('Do not invent versions, patch IDs, commands');
  });

  it('bounds valid output to two or three concise steps', () => {
    const steps = normalizeAlertRemediationOutput(
      JSON.stringify({
        steps: [
          { title: ' First ', body: ' Apply the supplied remediation guidance. ' },
          { title: 'Second', body: 'Verify the service using only known alert details.' },
          { title: 'Third', body: 'Record the result for the operator.' },
          { title: 'Fourth', body: 'This must not be returned.' },
        ],
      }),
    );
    expect(steps).toHaveLength(3);
    expect(steps?.every((step) => step.id && step.title && step.body)).toBe(true);
  });

  it('returns unavailable for invalid, blank, or underspecified model output', () => {
    expect(normalizeAlertRemediationOutput('not json')).toBeNull();
    expect(normalizeAlertRemediationOutput({ steps: [{ title: '', body: 'blank title' }] })).toBeNull();
    expect(normalizeAlertRemediationOutput({ steps: [{ title: 'Only one', body: 'Not enough steps.' }] })).toBeNull();
  });
});
