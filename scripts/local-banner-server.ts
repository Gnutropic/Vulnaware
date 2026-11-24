// @polsia:user-owned — Configurable loopback-only TCP banner server for local
// scanner tests and research demonstrations.

import { createServer, type Server } from 'node:net';
import { resolve } from 'node:path';
import { isLoopbackLiteral } from './local-scan-core';

interface BannerServerOptions {
  host: string;
  port: number;
  banner: string;
}

interface RunningBannerServer {
  server: Server;
  host: string;
  port: number;
}

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 2_222;
const DEFAULT_BANNER = 'VulnAware sample banner\r\n';

export async function startBannerServer(options: BannerServerOptions): Promise<RunningBannerServer> {
  if (!isLoopbackLiteral(options.host)) {
    throw new Error(`Banner server can bind only to a loopback IP: ${options.host}`);
  }
  if (!Number.isSafeInteger(options.port) || options.port < 0 || options.port > 65_535) {
    throw new Error('Banner server port must be an integer from 0 to 65535.');
  }

  const server = createServer((socket) => {
  socket.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code !== 'ECONNRESET' && error.code !== 'EPIPE') {
      console.error('Client socket error:', error.message);
    }
  });

  // Keep the TCP session open through tcp-probe's banner window.
  socket.write(options.banner);
});

  return new Promise<RunningBannerServer>((resolve, reject) => {
    const onError = (error: Error) => {
      server.close();
      reject(error);
    };
    server.once('error', onError);
    server.listen({ host: options.host, port: options.port }, () => {
      server.off('error', onError);
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Banner server did not bind to a TCP address.'));
        return;
      }
      resolve({ server, host: options.host, port: address.port });
    });
  });
}

function parseArguments(args: string[]): BannerServerOptions | 'help' {
  const values = new Map<string, string>();
  const accepted = new Set(['--host', '--port', '--banner']);
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === '--help') return 'help';
    if (!flag || !accepted.has(flag)) throw new Error(`Unknown option: ${flag ?? ''}`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${flag}.`);
    if (values.has(flag)) throw new Error(`Option provided more than once: ${flag}`);
    values.set(flag, value);
    index += 1;
  }

  const port = Number(values.get('--port') ?? DEFAULT_PORT);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new Error('--port must be an integer from 0 to 65535.');
  }
  return {
    host: values.get('--host') ?? DEFAULT_HOST,
    port,
    banner: values.get('--banner') ?? DEFAULT_BANNER,
  };
}

async function main(): Promise<void> {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options === 'help') {
      process.stdout.write(
        `VulnAware local TCP banner server\n\nUsage:\n  npx tsx scripts/local-banner-server.ts [--host 127.0.0.1] [--port 2222] [--banner <text>]\n\n` +
          `The server binds to loopback only. Port 0 selects an available port.\n`,
      );
      return;
    }

    const running = await startBannerServer(options);
    process.stdout.write(`Banner server listening on ${running.host}:${running.port}\n`);
    const stop = () => {
      running.server.close(() => process.exit(0));
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unexpected banner server failure.';
    process.stderr.write(`Banner server failed: ${message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]).endsWith('/scripts/local-banner-server.ts')) {
  void main();
}
