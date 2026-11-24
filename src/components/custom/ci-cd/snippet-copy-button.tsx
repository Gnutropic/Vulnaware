// @polsia:user-owned — Tiny client island used inside the "Wire it up"
// section. Copies a code snippet to the clipboard and surfaces a transient
// toast so an operator can drop the snippet into their repo verbatim.
// `value` is a plain STRING — not React children interpolating `${VAR}` —
// so the literal `${CI_WEBHOOK_TOKEN}` in the GitHub Actions YAML survives
// copy-paste (React would otherwise happily interpolate `${…}` expressions
// in JSX children, which is the trap a baked-string avoids).

'use client';

import { Check, Clipboard } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';

export interface SnippetCopyButtonProps {
  value: string;
  label: string;
}

export function SnippetCopyButton({ value, label }: SnippetCopyButtonProps) {
  const [copied, setCopied] = useState(false);

  const onCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      toast.success('Copied');
    } catch {
      toast.error('Could not copy — your browser blocked the clipboard');
    }
  }, [value]);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);

  return (
    <Button type="button" variant="outline" size="sm" onClick={onCopy} aria-label={`Copy ${label}`}>
      {copied ? (
        <Check className="size-4" aria-hidden />
      ) : (
        <Clipboard className="size-4" aria-hidden />
      )}
      {copied ? 'Copied' : 'Copy'}
    </Button>
  );
}
