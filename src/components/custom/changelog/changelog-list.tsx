// @polsia:user-owned — public /changelog client island. Reads the typed
// changelog feed from /api/changelog via @/lib/api-client and renders the
// stable, date-free entries in their authored order.
//
// SSR delivers the empty "Loading…" placeholder; the island hydrates, fetches
// once, then commits the list.
'use client';

import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { apiFetch } from '@/lib/api-client';
import type { InlineNode } from '@/lib/content/markdown';
import { parseMarkdown } from '@/lib/content/markdown';
import type { ChangelogEntry } from '@/lib/contracts/changelog';
import { ChangelogList as ChangelogListSchema } from '@/lib/contracts/changelog';

type FetchState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; entries: ChangelogEntry[] };

export function ChangelogList() {
  const [state, setState] = useState<FetchState>({ status: 'loading' });

  useEffect(() => {
    let active = true;
    apiFetch('/api/changelog', { schema: ChangelogListSchema })
      .then((data) => {
        if (active) {
          setState({ status: 'ready', entries: data.entries });
        }
      })
      .catch((err: unknown) => {
        if (active) {
          const message = err instanceof Error ? err.message : 'Could not load updates.';
          setState({ status: 'error', message });
        }
      });
    return () => {
      active = false;
    };
  }, []);

  if (state.status === 'loading') {
    return (
      <output className="text-body text-muted-foreground" aria-live="polite">
        Loading updates…
      </output>
    );
  }

  if (state.status === 'error') {
    return (
      <p className="text-body text-destructive" role="alert">
        {state.message}
      </p>
    );
  }

  if (state.entries.length === 0) {
    return <p className="text-body text-muted-foreground">No updates yet.</p>;
  }

  return (
    <ol className="flex flex-col gap-6">
      {state.entries.map((entry) => (
        <li
          key={entry.id}
          id={`entry-${entry.id}`}
          className="relative flex flex-col gap-2 border-l-2 border-brand-500/40 bg-card/60 pl-6 pr-4 py-5 rounded-r-[var(--radius-lg)] shadow-sm"
        >
          <div className="flex flex-wrap items-center gap-3">
            <Badge variant="outline" className="rounded-full font-normal text-muted-foreground">
              Shipped
            </Badge>
          </div>
          <h3 className="font-display text-h3 tracking-tight text-foreground">{entry.title}</h3>
          <div className="flex flex-col gap-3 text-body text-muted-foreground">
            {parseMarkdown(entry.body).map((block) => (
              <p key={block.key} className="m-0 leading-relaxed">
                {block.children.map((node) => (
                  <Inline key={node.key} node={node} />
                ))}
              </p>
            ))}
          </div>
        </li>
      ))}
    </ol>
  );
}

function Inline({ node }: { node: InlineNode }): ReactNode {
  switch (node.type) {
    case 'text':
      return node.value;
    case 'br':
      return <br />;
    case 'strong':
      return (
        <strong className="font-semibold text-foreground">{renderChildren(node.children)}</strong>
      );
    case 'em':
      return <em className="italic">{renderChildren(node.children)}</em>;
    case 'link':
      return (
        <a
          href={node.href}
          rel="noopener noreferrer"
          className="font-medium text-foreground underline-offset-4 transition-colors hover:text-brand-500 hover:underline"
        >
          {renderChildren(node.children)}
        </a>
      );
  }
}

function renderChildren(children: InlineNode[]): ReactNode {
  return children.map((child) => <Inline key={child.key} node={child} />);
}
