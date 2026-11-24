// @vitest-environment node
import { createServer, type Server } from 'node:net';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertAllowlistedTarget,
  isPrivateOrLoopbackLiteral,
  loadAllowlist,
  runLocalScan,
  writeScanResult,
  type LocalScanResult,
  type LocalTarget,
} from '../../../scripts/local-scan-core';
import { startBannerServer } from '../../../scripts/local-banner-server';
import type { ProbeResult } from '../../../src/lib/business/scanner/tcp-probe';

const temporaryDirectories: string[] = [];
const runningServers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    runningServers.splice(0).map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'vulnaware-local-scan-'));
  temporaryDirectories.push(path);
  return path;
}

async function reserveAndReleaseLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not reserve a test port.');
  const { port } = address;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

function unusedProbe(): typeof import('../../../src/lib/business/scanner/tcp-probe').probe {
  return vi.fn(async (): Promise<ProbeResult> => ({
    state: 'up',
    latencyMs: 1,
    banner: null,
  }));
}

describe('local TCP scan authorization', () => {
  it('accepts loopback and private literal IPs and rejects DNS names or public addresses', () => {
    for (const address of ['127.0.0.1', '10.4.2.1', '172.16.0.1', '192.168.1.20', '::1', 'fd12::1']) {
      expect(isPrivateOrLoopbackLiteral(address), address).toBe(true);
    }
    for (const address of [
      'localhost',
      '8.8.8.8',
      '172.32.0.1',
      '2001:4860:4860::8888',
      '::ffff:127.0.0.1',
    ]) {
      expect(isPrivateOrLoopbackLiteral(address), address).toBe(false);
    }
  });

  it('requires an exact host-and-port pair and rejects before invoking the probe', async () => {
    const allowlist: LocalTarget[] = [{ host: '127.0.0.1', port: 2222 }];
    expect(() => assertAllowlistedTarget('127.0.0.1', 2222, allowlist)).not.toThrow();
    expect(() => assertAllowlistedTarget('127.0.0.1', 2223, allowlist)).toThrow(
      'not explicitly allowlisted',
    );

    const probeTarget = unusedProbe();
    for (const host of ['localhost', '8.8.8.8']) {
      await expect(
        runLocalScan({ host, port: 2222, allowlist, probeTarget }),
      ).rejects.toThrow('loopback or private literal IP');
    }
    await expect(
      runLocalScan({ host: '127.0.0.1', port: 2223, allowlist, probeTarget }),
    ).rejects.toThrow('not explicitly allowlisted');
    expect(probeTarget).not.toHaveBeenCalled();
  });

  it('rejects a public host in the allowlist file itself', async () => {
    const directory = await temporaryDirectory();
    const filePath = join(directory, 'allowlist.json');
    await writeFile(
      filePath,
      JSON.stringify({ targets: [{ host: '8.8.8.8', port: 443 }] }),
      'utf8',
    );
    await expect(loadAllowlist(filePath)).rejects.toThrow('not a private literal IP');
  });
});

describe('local banner server and output', () => {
  it('records an open port, received raw banner, detector result, seed candidate, and JSON faithfully', async () => {
    const server = await startBannerServer({
      host: '127.0.0.1',
      port: 0,
      banner: 'OpenSSL/1.0.1e\r\n',
    });
    runningServers.push(server.server);
    const result = await runLocalScan({
      host: server.host,
      port: server.port,
      allowlist: [{ host: server.host, port: server.port }],
    });

    expect(result.target).toBe('127.0.0.1');
    expect(result.port).toBe(server.port);
    expect(Date.parse(result.startedAt)).not.toBeNaN();
    expect(Date.parse(result.endedAt)).not.toBeNaN();
    expect(result.observations).toMatchObject({
      tcpState: 'up',
      bannerReceived: true,
      rawBanner: 'OpenSSL/1.0.1e\r\n',
      serviceIdentification: {
        serviceHint: 'https-alt',
        banner: 'OpenSSL/1.0.1e',
      },
    });
    expect(result.observations.latencyMs).toEqual(expect.any(Number));
    expect(result.heuristicCveCandidates.verified).toBe(false);
    expect(result.heuristicCveCandidates.items).toContainEqual({
      cveId: 'CVE-2014-0160',
      severity: 'High',
      reason: expect.stringContaining('OpenSSL 1.0.1 banner'),
      source: 'banner',
    });

    const directory = await temporaryDirectory();
    const outputPath = join(directory, 'result.json');
    await writeScanResult(outputPath, result);
    const serialized = await readFile(outputPath, 'utf8');
    const decoded = JSON.parse(serialized) as LocalScanResult;
    expect(decoded).toEqual(result);
    expect(serialized).toContain('"heuristicCveCandidates"');
    expect(serialized).toContain('"observations"');
    expect(serialized).toContain('"verified": false');
  });

  it('reports a closed loopback port as down', async () => {
    const port = await reserveAndReleaseLoopbackPort();
    const result = await runLocalScan({
      host: '127.0.0.1',
      port,
      allowlist: [{ host: '127.0.0.1', port }],
      timeoutMs: 500,
    });
    expect(result.observations.tcpState).toBe('down');
    expect(result.observations.bannerReceived).toBe(false);
    expect(result.observations.rawBanner).toBeNull();
  });

  it('binds the banner server to loopback only', async () => {
    await expect(
      startBannerServer({ host: '0.0.0.0', port: 2222, banner: 'not exposed' }),
    ).rejects.toThrow('loopback IP');
  });
});
