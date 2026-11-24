// @polsia:user-owned — best-effort service identification from a banner + the
// port the probe succeeded on. Intentionally tiny regex grabbers — the MVP
// classifies against a small allowlist (ssh, http, https, http-alt, https-alt)
// so the matcher can decide which feed (OSV vs NVD) to query.

const SSH_PREFIX = /^SSH-([\d.]+)-(.+?)(?:\r|\n)/;
const HTTP_SERVER = /^Server:\s*([^\r\n]+)/im;
const OPENSSL_INLINE = /OpenSSL\/([\d.]+[a-z]?)/i;

export interface DetectedService {
  serviceHint: string | null;
  banner: string | null;
}

/**
 * Parse a TCP banner (or null) and the port the probe went through; return a
 * coarse service hint suitable for matcher routing. Banner is preserved so it
 * can be persisted to the Asset row and surfaced in the UI.
 */
export function detectService(port: number, banner: string | null): DetectedService {
  const payload = banner ?? '';
  if (!payload) {
    // Fall back to port-based heuristics when no banner was returned. This
    // covers HTTPS where the server does not push anything until we send a
    // ClientHello inside a TLS handshake (out of scope for the MVP probe).
    if (port === 22) return { serviceHint: 'ssh', banner: null };
    if (port === 80 || port === 8080)
      return { serviceHint: port === 80 ? 'http' : 'http-alt', banner: null };
    if (port === 443 || port === 8443)
      return { serviceHint: port === 443 ? 'https' : 'https-alt', banner: null };
    return { serviceHint: null, banner: null };
  }

  // SSH pushes its protocol banner immediately on connect.
  const sshMatch = payload.match(SSH_PREFIX);
  if (sshMatch) {
    return { serviceHint: 'ssh', banner: payload.trim().slice(0, 256) };
  }

  // HTTP servers send a request to elicit a response. The probe didn't send
  // one, so a real banner is rare — but if we did capture one, parse the
  // Server header.
  const httpMatch = payload.match(HTTP_SERVER);
  if (httpMatch) {
    return {
      serviceHint: classifyHttp(httpMatch[1] ?? '', port),
      banner: payload.trim().slice(0, 256),
    };
  }

  // HTTPS ports can still echo an OpenSSL version in some misconfigurations.
  const tlsMatch = payload.match(OPENSSL_INLINE);
  if (tlsMatch) {
    return {
      serviceHint: port === 443 ? 'https' : 'https-alt',
      banner: payload.trim().slice(0, 256),
    };
  }

  return { serviceHint: 'unknown', banner: payload.trim().slice(0, 256) };
}

function classifyHttp(serverHeader: string, port: number): string {
  const hint = port === 80 ? 'http' : 'http-alt';
  if (/nginx/i.test(serverHeader)) return 'nginx';
  if (/apache|httpd/i.test(serverHeader)) return 'apache';
  if (/OpenSSL/i.test(serverHeader)) return hint;
  return hint;
}

// Maps a serviceHint to the OSV package { name, ecosystem } we would query.
// The MVP matcher doesn't actively call this (no real version on the probe —
// the seed table drives CVE matching) but the helper exists so a future run
// can wire the round-trip without re-touching the matcher contract.
export function packageForService(
  serviceHint: string | null,
): { name: string; ecosystem: string } | null {
  switch (serviceHint) {
    case 'nginx':
      return { name: 'nginx', ecosystem: 'OSS-Fuzz' };
    case 'apache':
      return { name: 'httpd', ecosystem: 'OSS-Fuzz' };
    case 'ssh':
      return { name: 'openssh', ecosystem: 'OSS-Fuzz' };
    default:
      return null;
  }
}
