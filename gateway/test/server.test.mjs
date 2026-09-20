import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';

import { GatewayError } from '../errors.mjs';
import {
  createGateway,
  createGatewayHandler,
  startGateway,
} from '../server.mjs';
import { eventually, temporaryConfig, withTemporaryDirectory } from './helpers.mjs';

async function listen(server, host = '127.0.0.1', port = 0) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  return server.address();
}

async function close(server) {
  if (!server.listening) return;
  await new Promise((resolve) => server.close(resolve));
}

function authorizedHeaders(extra = {}) {
  return { Authorization: 'Bearer test-gateway-token', ...extra };
}

test('HTTP contract enforces bearer auth, CORS, methods, body type, and size', async () => {
  await withTemporaryDirectory('math-reader-server-', async (directory) => {
    const calls = [];
    const engine = {
      async status() {
        calls.push('status');
        return { ready: true };
      },
      async models() {
        calls.push('models');
        return { data: [{ id: 'codex-smart' }] };
      },
      async ask(body) {
        calls.push({ ask: body });
        return { text: 'answer', model: 'codex-smart' };
      },
    };
    const config = temporaryConfig(directory, {
      maxBodyBytes: 256,
      requestTimeoutMs: 1_000,
    });
    const server = createHttpServer(
      createGatewayHandler({ config, engine, token: 'test-gateway-token' }),
    );
    const address = await listen(server);
    const base = `http://127.0.0.1:${address.port}`;
    try {
      let response = await fetch(`${base}/v1/status`);
      assert.equal(response.status, 401);
      assert.equal((await response.json()).error.code, 'unauthorized');
      assert.match(response.headers.get('www-authenticate'), /^Bearer/);

      response = await fetch(`${base}/v1/status`, {
        headers: authorizedHeaders({ Origin: 'https://allowed.example' }),
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { ready: true });
      assert.equal(response.headers.get('access-control-allow-origin'), 'https://allowed.example');

      response = await fetch(`${base}/v1/status`, {
        headers: authorizedHeaders({ Origin: 'https://evil.example' }),
      });
      assert.equal(response.status, 403);
      assert.equal((await response.json()).error.code, 'origin_not_allowed');

      response = await fetch(`${base}/v1/ask`, {
        method: 'OPTIONS',
        headers: { Origin: 'https://allowed.example' },
      });
      assert.equal(response.status, 204);
      assert.equal(response.headers.get('access-control-allow-origin'), 'https://allowed.example');

      response = await fetch(`${base}/v1/ask`, {
        method: 'POST',
        headers: authorizedHeaders(),
        body: '{}',
      });
      assert.equal(response.status, 415);
      assert.equal((await response.json()).error.code, 'unsupported_media_type');

      const body = { messages: [{ role: 'user', content: 'hello' }] };
      response = await fetch(`${base}/v1/ask`, {
        method: 'POST',
        headers: authorizedHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { text: 'answer', model: 'codex-smart' });
      assert.deepEqual(calls.at(-1), { ask: body });

      const askCount = calls.filter((call) => typeof call === 'object').length;
      response = await fetch(`${base}/v1/ask`, {
        method: 'POST',
        headers: authorizedHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ messages: [{ role: 'user', content: 'x'.repeat(500) }] }),
      });
      assert.equal(response.status, 413);
      assert.equal((await response.json()).error.code, 'request_too_large');
      assert.equal(response.headers.get('connection'), 'close');
      assert.equal(calls.filter((call) => typeof call === 'object').length, askCount);

      response = await fetch(`${base}/v1/status?extra=1`, { headers: authorizedHeaders() });
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error.code, 'invalid_request');
    } finally {
      await close(server);
    }
  });
});

test('slow request bodies time out without occupying the connection indefinitely', async () => {
  await withTemporaryDirectory('math-reader-server-', async (directory) => {
    let askCalled = false;
    const config = temporaryConfig(directory, {
      maxBodyBytes: 1024,
      requestTimeoutMs: 40,
    });
    const engine = {
      async ask() {
        askCalled = true;
        return { text: 'unexpected' };
      },
    };
    const server = createHttpServer(
      createGatewayHandler({ config, engine, token: 'test-gateway-token' }),
    );
    const address = await listen(server);
    try {
      const result = await new Promise((resolve, reject) => {
        let settled = false;
        const request = httpRequest({
          host: '127.0.0.1',
          port: address.port,
          path: '/v1/ask',
          method: 'POST',
          headers: authorizedHeaders({
            'Content-Type': 'application/json',
            'Transfer-Encoding': 'chunked',
          }),
        });
        const timeout = setTimeout(() => {
          if (settled) return;
          settled = true;
          request.destroy();
          reject(new Error('slow request body left the connection hanging'));
        }, 1_000);
        request.on('response', (response) => {
          const chunks = [];
          response.on('data', (chunk) => chunks.push(chunk));
          response.on('end', () => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            resolve({
              statusCode: response.statusCode,
              headers: response.headers,
              body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
            });
          });
        });
        request.on('error', (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          reject(error);
        });
        request.write('{"messages":');
      });

      assert.equal(result.statusCode, 504);
      assert.equal(result.body.error.code, 'request_timeout');
      assert.equal(result.headers.connection, 'close');
      assert.equal(askCalled, false);
    } finally {
      server.closeAllConnections?.();
      await close(server);
    }
  });
});

test('client disconnect aborts an in-flight engine request', async () => {
  await withTemporaryDirectory('math-reader-server-', async (directory) => {
    let askStarted = false;
    let disconnectReason;
    const config = temporaryConfig(directory, { requestTimeoutMs: 5_000 });
    const engine = {
      ask(_body, { signal }) {
        askStarted = true;
        return new Promise((resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              disconnectReason = signal.reason;
              reject(signal.reason);
            },
            { once: true },
          );
        });
      },
    };
    const server = createHttpServer(
      createGatewayHandler({ config, engine, token: 'test-gateway-token' }),
    );
    const address = await listen(server);
    try {
      const request = httpRequest({
        host: '127.0.0.1',
        port: address.port,
        path: '/v1/ask',
        method: 'POST',
        headers: authorizedHeaders({ 'Content-Type': 'application/json' }),
      });
      request.on('error', () => {});
      request.end(JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] }));
      await eventually(() => askStarted);
      request.destroy();
      await eventually(() => disconnectReason);
      assert.equal(disconnectReason.code, 'client_disconnected');
      assert.equal(disconnectReason.statusCode, 499);
    } finally {
      server.closeAllConnections?.();
      await close(server);
    }
  });
});

test('gateway creation stops a started engine when later startup validation fails', async () => {
  await withTemporaryDirectory('math-reader-server-', async (directory) => {
    const events = [];
    const engine = {
      async start() {
        events.push('start');
      },
      async stop() {
        events.push('stop');
      },
    };
    const config = temporaryConfig(directory, {
      tlsCertificateFile: `${directory}/missing-cert.pem`,
      tlsKeyFile: `${directory}/missing-key.pem`,
    });
    await assert.rejects(createGateway(config, { engine, token: 'token' }), { code: 'ENOENT' });
    assert.deepEqual(events, ['start', 'stop']);

    events.length = 0;
    const remoteConfig = temporaryConfig(directory, { host: '0.0.0.0' });
    await assert.rejects(createGateway(remoteConfig, { engine, token: 'token', tls: null }), {
      code: 'insecure_remote_bind_refused',
    });
    assert.deepEqual(events, ['start', 'stop']);
  });
});

test('listen failure stops the engine instead of leaving Codex running', async () => {
  await withTemporaryDirectory('math-reader-server-', async (directory) => {
    const occupied = createHttpServer((_request, response) => response.end());
    const address = await listen(occupied);
    const events = [];
    const engine = {
      async start() {
        events.push('start');
      },
      async stop() {
        events.push('stop');
      },
    };
    const config = temporaryConfig(directory, { port: address.port });
    try {
      await assert.rejects(
        startGateway(config, { engine, token: 'token', tls: null }),
        (error) => error.code === 'EADDRINUSE',
      );
      assert.deepEqual(events, ['start', 'stop']);
    } finally {
      await close(occupied);
    }
  });
});

test('graceful stop fails an in-flight request and returns promptly', async () => {
  await withTemporaryDirectory('math-reader-server-', async (directory) => {
    let rejectAsk;
    let askStarted = false;
    const engine = {
      async start() {},
      ask() {
        askStarted = true;
        return new Promise((_resolve, reject) => {
          rejectAsk = reject;
        });
      },
      async stop() {
        rejectAsk?.(new GatewayError('codex_unavailable', 'Gateway is stopping.', 503));
      },
    };
    const config = temporaryConfig(directory, { port: 0 });
    const gateway = await startGateway(config, {
      engine,
      token: 'test-gateway-token',
      tls: null,
    });
    const address = gateway.server.address();
    const responsePromise = fetch(`http://127.0.0.1:${address.port}/v1/ask`, {
      method: 'POST',
      headers: authorizedHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] }),
    });
    await eventually(() => askStarted);

    const startedAt = Date.now();
    await gateway.stop();
    assert.ok(Date.now() - startedAt < 1_000, 'stop should not wait for the request timeout');
    const response = await responsePromise;
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, 'codex_unavailable');
  });
});
