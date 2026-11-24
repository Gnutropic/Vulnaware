// @polsia:user-owned — Asset Discovery & CVE Detection Engine. Lists past scans
// and offers a "start a TCP-only scan" form bound to the shared contract. All
// data is fetched from the client via @/lib/api-client; the page exports no
// Server Component metadata (it MUST be 'use client' to call apiFetch).

'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { Copy, Loader2, PlayCircle, ScanSearch, ShieldAlert, Terminal } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { ScanResultCard } from '@/components/custom/scan-result-card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { apiFetch } from '@/lib/api-client';
import {
  ALLOWED_PORT_VALUES,
  ScanCreate,
  type ScanCreateInput,
  ScanItem,
  ScanList,
} from '@/lib/contracts/scan';
import { applyServerErrors } from '@/lib/forms';

const DEFAULT_PORT = '443';

// CI/CD integration snippet shown to ops engineers wiring shift-left scans
// into their build pipeline. The endpoints ($NEXT_PUBLIC_APP_URL) and the
// shared secret ($VULN_API_KEY) are intentionally env-var placeholders so
// the same snippet works in CI runners, local dev, and staging. The poll
// follow-up reuses $VULN_API_KEY so the integration only ever needs to
// provision ONE secret per environment.
const CURL_SNIPPET = `# Trigger a scan post-build (uses repository.url's host as the target)
RESP=$(curl -sS -X POST "$NEXT_PUBLIC_APP_URL/api/v1/webhooks/trigger" \\
  -H "content-type: application/json" \\
  -H "x-api-key: $VULN_API_KEY" \\
  -d '{
    "repository": { "url": "https://github.com/acme/payments-api" },
    "ports": [443],
    "mode": "tcp-only"
  }')

# Capture the scan id and poll findings until the scan reaches a terminal state
SCAN_ID=$(jq -r .id <<<"$RESP")
curl -sS "$NEXT_PUBLIC_APP_URL/api/v1/scans/$SCAN_ID/findings" \\
  -H "x-api-key: $VULN_API_KEY"`;

export default function ScansPage() {
  const router = useRouter();
  const [list, setList] = useState<ScanItem[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [curlCopied, setCurlCopied] = useState(false);

  const handleCopyCurl = async () => {
    try {
      await navigator.clipboard.writeText(CURL_SNIPPET);
      setCurlCopied(true);
      window.setTimeout(() => setCurlCopied(false), 1500);
      toast.success('cURL snippet copied');
    } catch {
      toast.error('Could not access clipboard');
    }
  };

  const form = useForm<ScanCreateInput>({
    resolver: zodResolver(ScanCreate),
    defaultValues: { target: '', ports: [443], mode: 'tcp-only' },
  });

  useEffect(() => {
    let active = true;
    apiFetch('/api/scan', { schema: ScanList })
      .then((data) => {
        if (active) setList(data.items);
      })
      .catch(() => {
        if (active) setListError('Could not load scans. Try again in a moment.');
      });
    return () => {
      active = false;
    };
  }, []);

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      const created = await apiFetch('/api/scan', {
        method: 'POST',
        body: JSON.stringify(values),
        schema: ScanItem,
      });
      toast.success(`Scan queued for ${created.target}.`);
      router.push(`/scans/${created.id}`);
    } catch (err) {
      const applied = err instanceof Error && applyServerErrors(err.cause, form.setError);
      if (!applied) {
        toast.error('Scan failed. Verify the hostname is reachable and try again.');
      }
    }
  });

  return (
    <main className="container-page section-lg space-y-12">
      <header className="flex flex-col gap-2">
        <p className="text-eyebrow text-muted-foreground">
          <ScanSearch className="mr-1.5 inline size-4 align-[-0.18em] text-brand-500" /> Asset
          Discovery
        </p>
        <h1 className="font-display text-h1 tracking-tight text-foreground">
          TCP-only vulnerability scans
        </h1>
        <p className="max-w-prose text-body-lg text-muted-foreground">
          Probe a public hostname across a small allowlist of ports. Results are matched against the
          local CVE seed and (when reachable) the live NVD / OSV.dev feeds.
        </p>
      </header>

      <Card className="border-border/80 bg-card shadow-sm">
        <CardHeader>
          <CardTitle className="font-display text-h3 text-foreground">Start a scan</CardTitle>
          <CardDescription>
            Bounded scope: one hostname, up to five ports from the allowlist. Loopback, link-local,
            and reserved ranges are hard-rejected.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Form {...form}>
            <form
              onSubmit={onSubmit}
              className="grid gap-4 md:grid-cols-[1.4fr_1fr_auto] md:items-end"
              noValidate
            >
              <FormField
                control={form.control}
                name="target"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Hostname or IP</FormLabel>
                    <FormControl>
                      <Input
                        placeholder="example.com"
                        autoComplete="off"
                        spellCheck={false}
                        {...field}
                      />
                    </FormControl>
                    <FormDescription>Must be a public, routable address.</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="ports"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Starting port</FormLabel>
                    <FormControl>
                      <Select
                        value={String(field.value[0] ?? DEFAULT_PORT)}
                        onValueChange={(value) => field.onChange([Number.parseInt(value, 10)])}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Pick a port" />
                        </SelectTrigger>
                        <SelectContent>
                          {ALLOWED_PORT_VALUES.map((port) => (
                            <SelectItem key={port} value={String(port)}>
                              {port} ({portLabel(port)})
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </FormControl>
                    <FormDescription>
                      Extend the matcher: ssh {`-> 22`}, https {`-> 443`}, http-alt {`-> 8080`}.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <Button type="submit" disabled={form.formState.isSubmitting} className="shadow-brand">
                {form.formState.isSubmitting ? (
                  <>
                    <Loader2 className="size-4 animate-spin" aria-hidden /> Scanning…
                  </>
                ) : (
                  <>
                    <PlayCircle className="size-4" aria-hidden /> Run scan
                  </>
                )}
              </Button>
            </form>
          </Form>
        </CardContent>
      </Card>

      <section aria-labelledby="recent-heading" className="space-y-4">
        <div className="flex items-baseline justify-between">
          <h2 id="recent-heading" className="font-display text-h2 text-foreground">
            Recent scans
          </h2>
          <Badge variant="outline" className="font-mono text-caption">
            {list.length} total
          </Badge>
        </div>
        {listError ? (
          <p className="text-body text-destructive">{listError}</p>
        ) : list.length === 0 ? (
          <Card className="border-dashed border-border bg-card">
            <CardContent className="flex flex-col items-start gap-3 p-6 text-body text-muted-foreground">
              <ShieldAlert className="size-5 text-brand-500" aria-hidden />
              <p>No scans yet. Run your first one above to populate the list.</p>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4">
            {list.map((scan) => (
              <Link
                key={scan.id}
                href={`/scans/${scan.id}`}
                className="block rounded-[var(--radius-xl)] outline-none transition-transform hover:-translate-y-0.5 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                <ScanResultCard scan={scan} />
              </Link>
            ))}
          </div>
        )}
      </section>

      <section aria-labelledby="ci-cd-heading" className="space-y-4">
        <div className="flex items-baseline justify-between">
          <h2 id="ci-cd-heading" className="font-display text-h2 text-foreground">
            CI/CD Integration
          </h2>
          <Badge variant="outline" className="font-mono text-caption">
            shift-left
          </Badge>
        </div>
        <Card className="border-border/80 bg-card shadow-sm">
          <CardHeader>
            <CardTitle className="font-display text-h3 text-foreground">
              <Terminal className="mr-2 inline size-4 align-[-0.2em] text-brand-500" aria-hidden />{' '}
              Trigger from your build pipeline
            </CardTitle>
            <CardDescription>
              POST to <code className="font-mono">/api/v1/webhooks/trigger</code> after a deploy
              with a CI/CD-shaped body. The endpoint authenticates with the{' '}
              <code className="font-mono">x-api-key</code> header (your{' '}
              <code className="font-mono">$VULN_API_KEY</code>) and returns the new scan{' '}
              <code className="font-mono">id</code>, which you poll against the same auth-gated{' '}
              <code className="font-mono">/api/v1/scans/&#123;id&#125;/findings</code> endpoint.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-body text-muted-foreground">
              The snippet below uses <code className="font-mono">$NEXT_PUBLIC_APP_URL</code> and{' '}
              <code className="font-mono">$VULN_API_KEY</code> env vars — provision them once in
              your CI environment (defaults to{' '}
              <code className="font-mono">http://localhost:3000</code> in local dev).
            </p>
            <div className="relative">
              <pre className="overflow-x-auto rounded-[var(--radius-lg)] border border-border bg-background p-4 font-mono text-caption leading-relaxed text-foreground">
                <code>{CURL_SNIPPET}</code>
              </pre>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleCopyCurl}
                className="absolute right-3 top-3 shadow-sm"
              >
                <Copy className="size-3.5" aria-hidden />
                {curlCopied ? 'Copied' : 'Copy'}
              </Button>
            </div>
            <p className="text-caption text-muted-foreground">
              Targets are validated against the same public-routable allowlist as the form above
              (RFC1918, loopback, link-local, and reserved ranges are hard-rejected). Ports default
              to <code className="font-mono">[443]</code> and are further filtered to the shared{' '}
              <code className="font-mono">[22, 80, 443, 8080, 8443]</code> allowlist.
            </p>
          </CardContent>
        </Card>
      </section>
    </main>
  );
}

function portLabel(port: number): string {
  switch (port) {
    case 22:
      return 'ssh';
    case 80:
      return 'http';
    case 443:
      return 'https';
    case 8080:
      return 'http-alt';
    case 8443:
      return 'https-alt';
    default:
      return 'tcp';
  }
}
