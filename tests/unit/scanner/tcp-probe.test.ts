// @vitest-environment node
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Test-local socket mock — an EventEmitter with a `.destroy()` shim so the
// probe's cleanup paths can run without throwing.
class FakeSocket extends EventEmitter {
  destroyed = false;
  destroy() {
    this.destroyed = true;
  }
}

const captured: { latest: FakeSocket | null } = { latest: null };

vi.mock('node:net', () => ({
  // Returns a freshly-constructed socket so each test can decide the connect
  // outcome via emit('connect' | 'error' | 'data') + destroy().
  createConnection: vi.fn(() => {
    const s = new FakeSocket();
    captured.latest = s;
    return s as unknown as import('node:net').Socket;
  }),
}));

afterEach(() => {
  captured.latest?.removeAllListeners();
  captured.latest = null;
  vi.useRealTimers();
});

import { probe } from '@/lib/business/scanner/tcp-probe';

const nextTick = () => new Promise<void>((resolve) => setImmediate(resolve));

function readSocket(): FakeSocket {
  const socket = captured.latest;
  if (!socket) throw new Error('socket was not captured by the mock');
  return socket;
}

describe('probe()', () => {
  it('reports "up" + latency + banner after a successful connect', async () => {
    const promise = probe('example.com', 443, 1500);
    await nextTick();
    const socket = readSocket();
    socket.emit('connect');
    socket.emit('data', Buffer.from('Hello\n'));
    const result = await promise;
    expect(result.state).toBe('up');
    expect(result.latencyMs).not.toBeNull();
    expect(result.banner).toContain('Hello');
  });

  it('reports "down" when the socket errors with ECONNREFUSED', async () => {
    const promise = probe('example.com', 22, 1500);
    await nextTick();
    const socket = readSocket();
    const err = Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
    socket.emit('error', err);
    const result = await promise;
    expect(result.state).toBe('down');
    expect(result.banner).toBeNull();
  });

  it('reports "filtered" when neither connect nor error fires within the timeout', async () => {
    vi.useFakeTimers();
    const promise = probe('example.com', 443, 500);
    await vi.advanceTimersByTimeAsync(600);
    const result = await promise;
    expect(result.state).toBe('filtered');
    expect(result.latencyMs).toBeNull();
    expect(result.banner).toBeNull();
  });

  it('clamps banner length to 256 bytes', async () => {
    const big = 'A'.repeat(2000);
    const promise = probe('example.com', 80, 1500);
    await nextTick();
    const socket = readSocket();
    socket.emit('connect');
    socket.emit('data', Buffer.from(big));
    const result = await promise;
    expect(result.banner?.length).toBeLessThanOrEqual(256);
  });
});
