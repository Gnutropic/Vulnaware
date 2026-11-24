// @polsia:user-owned — TCP-connect probe via node:net. Records whether the
// remote accepts the SYN, measures round-trip, and (best-effort) peeks at
// the first bytes of an unsolicited service banner so the matcher can
// fingerprint OpenSSH/OpenSSL/HTTP servers.
//
// ICMP is intentionally not used here: this runs inside the PaaS Node sandbox
// where raw sockets / ICMP datagrams are unavailable.

import { createConnection } from 'node:net';

export type ProbeState = 'up' | 'down' | 'filtered';

export interface ProbeResult {
  state: ProbeState;
  latencyMs: number | null;
  banner: string | null;
}

/**
 * Open a TCP connection to `host:port` and report state + latency.
 *
 * - 'up'       — the remote completed the TCP handshake before the deadline.
 * - 'down'     — the connection was refused (RST) or the host is unreachable.
 * - 'filtered' — neither happened within `timeoutMs` (likely a firewall drop).
 */
export function probe(host: string, port: number, timeoutMs = 1500): Promise<ProbeResult> {
  return new Promise<ProbeResult>((resolve) => {
    const startedAt = process.hrtime.bigint();

    let settled = false;
    let bannerBuf = '';
    let bannerTimer: NodeJS.Timeout | null = null;

    const finish = (result: ProbeResult) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        // already destroyed
      }
      resolve(result);
    };

    const socket = createConnection({ host, port });

    const timer = setTimeout(() => {
      finish({ state: 'filtered', latencyMs: null, banner: null });
    }, timeoutMs);
    timer.unref?.();

    socket.once('connect', () => {
      const latency = Number(process.hrtime.bigint() - startedAt) / 1e6;
      // Try to read whatever the server pushes before we close. Mask the
      // banner window ~150ms to mimic how nmap -sV does it cheaply.
      bannerTimer = setTimeout(() => {
        finish({
          state: 'up',
          latencyMs: Math.max(1, Math.round(latency)),
          banner: bannerBuf || null,
        });
      }, 150);
      bannerTimer.unref?.();
    });

    socket.on('data', (chunk) => {
      // Cap banner at 256 bytes to bound string growth.
      if (bannerBuf.length < 256) {
        bannerBuf += chunk.toString('utf8', 0, Math.min(chunk.length, 256 - bannerBuf.length));
      }
    });

    socket.once('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      // ECONNREFUSED → host up, port closed. ENETUNREACH/EHOSTUNREACH → host
      // unreachable. Both surface as 'down' for the MVP; the operator can
      // read it as "TCP did not complete".
      const latency = Number(process.hrtime.bigint() - startedAt) / 1e6;
      const state: ProbeState = err.code === 'ECONNREFUSED' ? 'down' : 'down';
      finish({ state, latencyMs: Math.max(1, Math.round(latency)), banner: null });
    });

    socket.once('close', () => {
      // Defensive: if 'close' fires before 'connect' or 'error' (e.g. when
      // the remote resets after a probe), ensure we surface a result.
      if (!settled) {
        clearTimeout(timer);
        finish({ state: 'down', latencyMs: null, banner: bannerBuf || null });
      }
    });
  });
}
