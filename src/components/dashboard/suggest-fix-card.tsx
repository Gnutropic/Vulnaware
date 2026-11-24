// @polsia:user-owned — Per-alert one-shot "Suggest fix steps with AI"
// client island. Lives next to (NOT inside) the cached
// suggested-fix-card because they wire to different routes: the cached
// sibling owns /api/alerts/[id]/suggested-fix (Upsert on click, GET on
// cache hit), while THIS island wires to /api/alerts/[id]/suggest-fix
// (POST returns a fresh envelope — no persistence, no GET handler, no
// cache row to pre-render on mount).
//
// Naming & position contract:
//   - eyebrow `AI fix steps` (distinct from `AI brief` / `AI remediation`)
//   - title `Suggested fix steps` (distinct from `Explain with AI` /
//     `Suggested remediation` / `Suggested fix`)
//   - button label "Suggest fix steps with AI" (the brief's literal label)
//   - mounts between ExplainWithAiCard and SuggestedRemediationCard so
//     the reading order is: explanation → concrete fix checklist →
//     streamed remediation → fix snippet
//
// State machine (4 arms; POST-only):
//   - idle        → initial mount. No GET; the user clicks to generate.
//   - loading     → POST in flight; spinner in the button label.
//   - done        → steps parsed; rendered as `<ol>` with one `<li>`
//                   per step (title heading + body in `<pre><code>`).
//   - unavailable → 503 / network failure; toast.error fired; muted
//                   panel with the same button re-armed.
'use client';

import { Loader2, Sparkles } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { apiFetch } from '@/lib/api-client';
import { AlertFixSteps, type AlertFixSteps as AlertFixStepsType } from '@/lib/contracts/alerts';

interface SuggestFixAsset {
  id: string;
  host: string;
  ip: string;
  port: number;
  protocol: string;
  lastSeen: string | null;
}

interface SuggestFixCardProps {
  alertId: string;
  cveId: string;
  asset: SuggestFixAsset;
  // Alert description (the joined CveEntry.description text from
  // `AlertDetail.description`). The route sources a description
  // server-side from CveEntry directly; this client-side prop is
  // echoed below the header subtitle so the operator sees the
  // same line the AI model sees — paired with the CVE id + asset
  // context above. Empty string is acceptable; the call site
  // forwards `detail.description` verbatim from the parent.
  description: string;
}

type Status =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'done'; fix: AlertFixStepsType }
  | { kind: 'unavailable' };

export function SuggestFixCard({ alertId, cveId, asset, description }: SuggestFixCardProps) {
  // POST-only state machine. Initial mount is `idle` — no GET to fire
  // on mount (the route does not expose one), and no parent-supplied
  // initial steps (the route never persists one).
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  // Defends setStatus() against "unmount during POST" warnings. The
  // POST path holds an in-flight Promise whose `.then` may resolve
  // after the user navigates away — without this guard the bare
  // setStatus would trigger a React warning on the dead island.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  async function handleSuggestFix() {
    if (status.kind === 'loading') return;
    setStatus({ kind: 'loading' });
    try {
      const body = await apiFetch(`/api/alerts/${alertId}/suggest-fix`, {
        method: 'POST',
        schema: AlertFixSteps,
      });
      if (!mountedRef.current) return;
      setStatus({ kind: 'done', fix: body });
    } catch {
      if (!mountedRef.current) return;
      setStatus({ kind: 'unavailable' });
      toast.error('AI suggested fix unavailable. Try again in a moment.');
    }
  }

  const isLoading = status.kind === 'loading';
  const doneFix = status.kind === 'done' ? status.fix : null;

  return (
    <Card className="border-border/80 bg-card shadow-sm">
      <CardHeader className="space-y-2">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex flex-col gap-1">
            <CardDescription className="text-eyebrow uppercase tracking-wider text-muted-foreground">
              AI fix steps
            </CardDescription>
            <CardTitle className="flex items-center gap-2 text-h4 text-foreground">
              <Sparkles className="size-4 text-brand-500" aria-hidden />
              Suggested fix steps
            </CardTitle>
          </div>
          {/* The button row intentionally has ZERO sibling CTAs (no
              Regenerate, no Copy, no Dismiss). Each click POSTs a
              fresh call — the route does not persist, so a
              Regenerate CTA would be a literal clone of the click
              gesture itself; a Copy CTA would collide with the
              cached SuggestedFixCard sibling; a Dismiss CTA would
              read as a destructive gesture on a button that's
              already re-armable. The single primary button stays
              visible in idle / unavailable / done (no auto-dismiss
              on success) so the operator can ask for a fresh
              checklist from the same panel. */}
          <Button
            type="button"
            size="sm"
            onClick={() => void handleSuggestFix()}
            disabled={isLoading}
            aria-disabled={isLoading}
          >
            {isLoading ? (
              <>
                <Loader2 className="size-4 animate-spin" aria-hidden />
                Generating…
              </>
            ) : (
              <>
                <Sparkles className="size-4" aria-hidden />
                Suggest fix steps with AI
              </>
            )}
          </Button>
        </div>
        <CardDescription className="text-caption text-muted-foreground">
          <span className="font-mono">{cveId || 'UNKNOWN'}</span>
          {asset.host ? (
            <>
              {' '}
              on{' '}
              <span className="font-mono">
                {asset.host}
                {asset.ip ? `:${asset.port}/${asset.protocol}` : ''}
              </span>
            </>
          ) : null}
        </CardDescription>
        {/* Alert description echo — the joined CveEntry.description
            from `AlertDetail.description`, surfaced as a single muted
            line beneath the CVE-id-plus-asset subtitle so the operator
            sees the same description the AI prompt sees. Hidden when
            no description has been ingested yet (cold-cache) — the
            card still renders without it. */}
        {description ? (
          <p className="max-w-prose text-caption text-muted-foreground">{description}</p>
        ) : null}
      </CardHeader>
      <CardContent>
        {status.kind === 'idle' ? (
          <p className="max-w-prose text-body text-muted-foreground">
            Click Suggest fix steps with AI to get a fresh, AI-generated remediation checklist for
            this alert&rsquo;s stack.
          </p>
        ) : isLoading ? (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden />
            Generating fix steps…
          </div>
        ) : doneFix ? (
          doneFix.steps.length > 0 ? (
            <ol className="flex flex-col gap-3">
              {doneFix.steps.map((step, idx) => (
                // `key={step.id}` — the route computes a stable
                // sha256-based step id so the same fresh fix-step
                // surface delivered twice in a row keys through
                // React without a DOM reflow. List-index is
                // forbidden by the lint rule; the stable id is
                // always available because the alertId + step
                // content make the hash unique by construction.
                <li
                  key={step.id}
                  className="flex flex-col gap-1 rounded-lg border border-border/60 bg-muted/30 p-3"
                >
                  <span className="flex items-center gap-2">
                    <span className="font-mono text-caption uppercase tracking-wider text-muted-foreground">
                      Step {idx + 1}
                    </span>
                    <span className="font-medium text-body text-foreground">
                      {step.title || `Step ${idx + 1}`}
                    </span>
                  </span>
                  <pre className="overflow-x-auto whitespace-pre-wrap rounded-md border border-border/60 bg-background/60 p-2 font-mono text-caption text-foreground">
                    {step.body || '(empty step)'}
                  </pre>
                </li>
              ))}
            </ol>
          ) : (
            <p className="max-w-prose text-body text-muted-foreground">
              AI suggested fix is empty for this alert. Click Suggest fix steps with AI to retry.
            </p>
          )
        ) : (
          <div className="flex flex-col gap-1 text-body text-muted-foreground">
            <span>AI service temporarily unavailable.</span>
            <span className="text-caption">
              Click Suggest fix steps with AI to retry once the proxy is reachable.
            </span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
