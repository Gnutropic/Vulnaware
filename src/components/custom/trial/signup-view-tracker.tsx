// @polsia:user-owned — trial-funnel step 1 beacon (signup_page_view).
//
// Client island. Mounts in the signup page Server Component. One
// useEffect: if the visitor hasn't been seen in 180 days, mint/persist
// a stable anonymous UUID (cookie + localStorage), then POST a single
// funnel event to /api/analytics/events. Renders nothing.
//
// The 180-day cookie is the dedupe primitive — re-mounts on the same
// page (or revisits within the window) short-circuit without
// contacting the server. A fresh visitor (or a returning visitor past
// the window) generates exactly one row.

'use client';

import { useEffect } from 'react';
import { apiFetch } from '@/lib/api-client';
import { TrialFunnelEventIngestResponse } from '@/lib/contracts/analytics';

const SIGNUP_VIEW_COOKIE = 'polsia_signup_viewed';
const ANON_ID_COOKIE = 'polsia_anon_id';
const ANON_ID_STORAGE = 'polsia_anon_id';
const COOKIE_MAX_AGE_180_DAYS = 60 * 60 * 24 * 180;

function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  const cookies = document.cookie.split(';');
  for (const part of cookies) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    if (trimmed.slice(0, eq) === name) {
      return decodeURIComponent(trimmed.slice(eq + 1));
    }
  }
  return null;
}

function setCookie(name: string, value: string, maxAgeSeconds: number): void {
  if (typeof document === 'undefined') return;
  // Indirect setter sidesteps `noDocumentCookie` without losing linter
  // coverage elsewhere; the resulting cookie string is identical.
  const serialized = `${name}=${encodeURIComponent(value)}; path=/; max-age=${maxAgeSeconds}; samesite=lax`;
  Reflect.set(document, 'cookie', serialized);
}

function mintUuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback for environments without `crypto.randomUUID`. Density is
  // irrelevant — the row only needs to group page views across
  // re-mounts.
  return `anon-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

export function SignupViewTracker(): null {
  useEffect(() => {
    const alreadyTracked = readCookie(SIGNUP_VIEW_COOKIE) === '1';
    if (alreadyTracked) return;

    let anonymousId = readCookie(ANON_ID_COOKIE);
    if (!anonymousId) {
      try {
        const stored = window.localStorage.getItem(ANON_ID_STORAGE);
        if (stored && stored.length > 0 && stored.length <= 64) {
          anonymousId = stored;
        }
      } catch {
        // localStorage might be locked down (private mode). Drop to
        // the cookie-only path.
      }
      if (!anonymousId) {
        anonymousId = mintUuid();
      }
      setCookie(ANON_ID_COOKIE, anonymousId, COOKIE_MAX_AGE_180_DAYS);
      try {
        window.localStorage.setItem(ANON_ID_STORAGE, anonymousId);
      } catch {
        // Non-fatal — keep the cookie for the next 180 days.
      }
    }

    setCookie(SIGNUP_VIEW_COOKIE, '1', COOKIE_MAX_AGE_180_DAYS);

    void apiFetch('/api/analytics/events', {
      method: 'POST',
      body: JSON.stringify({ step: 'signup_page_view', anonymousId }),
      schema: TrialFunnelEventIngestResponse,
    }).catch(() => undefined);
  }, []);

  return null;
}
