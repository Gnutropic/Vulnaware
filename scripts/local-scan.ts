// @polsia:user-owned — Standalone local TCP scanner CLI; starts no web server.

import { resolve } from 'node:path';
import {
  loadAllowlist,
  runLocalScan,
  writeScanResult,
} from './local-scan-core';

interface CliOptions {
  host: string;
  port: number;
  allowlistPath: string;
  outputPath: string;
  timeoutMs: number;
}

const DEFAULT_ALLOWLIST = 'scripts/local-scan.allowlist.json';
const DEFAULT_TIMEOUT_MS = 1_500;

function printUsage(): void {
  process.stdout.write(`VulnAware local-only TCP scan\n\nUsage:\n  npx tsx scripts/local-scan.ts --host <literal-ip> --port <port> [options]\n\nOptions:\n  --allowlist <path>   JSON allowlist (default: ${DEFAULT_ALLOWLIST})\n  --output <path>      Result JSON (default: ./local-scan-results/<timestamp>.json)\n  --timeout-ms <ms>    TCP timeout (default: ${DEFAULT_TIMEOUT_MS})\n  --help               Show this help\n`);
}

function parseArguments(args: string[]): CliOptions | 'help' {
  const values = new Map<string, string>();
  const accepted = new Set(['--host', '--port', '--allowlist', '--output', '--timeout-ms']);

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === '--help') return 'help';
    if (!flag || !accepted.has(flag)) throw new Error(`Unknown option: ${flag ?? ''}`);
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}.`);
    if (values.has(flag)) throw new Error(`Option provided more than once: ${flag}`);
    values.set(flag, value);
    index += 1;
  }

  const host = values.get('--host');
  const portText = values.get('--port');
  if (!host || !portText) throw new Error('Both --host and --port are required.');

  const port = Number(portText);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('--port must be an integer from 1 to 65535.');
  }

  const timeoutText = values.get('--timeout-ms');
  const timeoutMs = timeoutText ? Number(timeoutText) : DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new Error('--timeout-ms must be an integer from 1 to 60000.');
  }

  const outputPath = values.get('--output') ?? defaultOutputPath();
  return {
    host,
    port,
    allowlistPath: resolve(values.get('--allowlist') ?? DEFAULT_ALLOWLIST),
    outputPath,
    timeoutMs,
  };
}

function defaultOutputPath(): string {
  const timestamp = new Date().toISOString().replaceAll(':', '-').replace('.', '-');
  return `./local-scan-results/scan-${timestamp}.json`;
}

async function main(): Promise<void> {
  try {
    const parsed = parseArguments(process.argv.slice(2));
    if (parsed === 'help') {
      printUsage();
      return;
    }

    const allowlist = await loadAllowlist(parsed.allowlistPath);
    const result = await runLocalScan({
      host: parsed.host,
      port: parsed.port,
      allowlist,
      timeoutMs: parsed.timeoutMs,
    });
    await writeScanResult(parsed.outputPath, result);
    process.stdout.write(
      `Scan saved to ${resolve(parsed.outputPath)}\nTCP state: ${result.observations.tcpState}\n` +
        `Unverified heuristic CVE candidates: ${result.heuristicCveCandidates.items.length}\n`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unexpected local scan failure.';
    process.stderr.write(`Local scan rejected or failed: ${message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]).endsWith('/scripts/local-scan.ts')) {
  void main();
}
