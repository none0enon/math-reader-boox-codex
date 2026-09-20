import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { CodexAppServer } from '../app-server.mjs';
import { appServerArguments, loadConfig } from '../config.mjs';
import { GatewayEngine } from '../engine.mjs';

const require = createRequire(import.meta.url);
const PINNED_CODEX_VERSION = '0.155.1';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function findType(value, expectedType, path = '$', matches = []) {
  if (!value || typeof value !== 'object') return matches;
  if (value.type === expectedType) matches.push(path);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => findType(entry, expectedType, `${path}[${index}]`, matches));
  } else {
    for (const [key, entry] of Object.entries(value)) {
      findType(entry, expectedType, `${path}.${key}`, matches);
    }
  }
  return matches;
}

test('real engine completes a zero-tool multimodal turn and unloads it', { timeout: 30_000 }, async (t) => {
  const packagePath = require.resolve('@openai/codex/package.json');
  const packageDirectory = dirname(packagePath);
  const packageMetadata = JSON.parse(await readFile(packagePath, 'utf8'));
  assert.equal(
    packageMetadata.version,
    PINNED_CODEX_VERSION,
    'Review the zero-tool capture before upgrading the pinned Codex runtime.',
  );

  const runtimeDirectory = await mkdtemp(join(tmpdir(), 'math-reader-codex-runtime-test-'));
  let appServer;
  let fakeProvider;
  t.after(async () => {
    await appServer?.stop();
    fakeProvider?.closeAllConnections?.();
    if (fakeProvider?.listening) await close(fakeProvider);
    await rm(runtimeDirectory, { recursive: true, force: true });
  });

  let resolveCapture;
  let rejectCapture;
  const capture = new Promise((resolve, reject) => {
    resolveCapture = resolve;
    rejectCapture = reject;
  });
  fakeProvider = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.once('error', rejectCapture);
    request.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        const outbound = {
          headers: request.headers,
          method: request.method,
          url: request.url,
          body: JSON.parse(raw),
        };
        resolveCapture(outbound);
        const events = [
          {
            type: 'response.created',
            response: { id: 'math-reader-response' },
          },
          {
            type: 'response.output_item.done',
            item: {
              type: 'message',
              role: 'assistant',
              id: 'math-reader-message',
              content: [{ type: 'output_text', text: 'runtime answer' }],
            },
          },
          {
            type: 'response.completed',
            response: {
              id: 'math-reader-response',
              usage: {
                input_tokens: 0,
                input_tokens_details: null,
                output_tokens: 0,
                output_tokens_details: null,
                total_tokens: 0,
              },
            },
          },
        ];
        const sse = events
          .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
          .join('');
        response.writeHead(200, {
          'Cache-Control': 'no-cache',
          Connection: 'close',
          'Content-Type': 'text/event-stream',
        });
        response.end(sse);
      } catch (error) {
        rejectCapture(error);
        response.writeHead(400).end();
      }
    });
  });
  await listen(fakeProvider);
  const providerAddress = fakeProvider.address();

  const config = loadConfig({
    MATH_READER_CODEX_BIN: process.execPath,
    MATH_READER_GATEWAY_STATE_DIR: join(runtimeDirectory, 'state'),
  });
  const codexEntrypoint = join(packageDirectory, 'bin', 'codex.js');
  const providerOverrides = [
    '-c',
    'model="math-reader-zero-tool-probe"',
    '-c',
    'model_provider="math_reader_runtime_test"',
    '-c',
    'model_providers.math_reader_runtime_test.name="math-reader-codex local runtime test"',
    '-c',
    `model_providers.math_reader_runtime_test.base_url="http://127.0.0.1:${providerAddress.port}/v1"`,
    '-c',
    'model_providers.math_reader_runtime_test.wire_api="responses"',
    '-c',
    'model_providers.math_reader_runtime_test.requires_openai_auth=false',
    '-c',
    'thread_unload_delay_secs=0',
  ];
  appServer = new CodexAppServer(config, {
    arguments: [codexEntrypoint, ...appServerArguments(), ...providerOverrides],
    environment: {},
  });

  await appServer.start();
  appServer.readAccount = async () => ({ type: 'chatgpt', planType: 'plus' });
  appServer.listModels = async () => [
    {
      id: 'math-reader-zero-tool-probe',
      model: 'math-reader-zero-tool-probe',
      displayName: 'math-reader-codex zero-tool probe',
      isDefault: true,
      hidden: false,
      inputModalities: ['text', 'image'],
      supportedReasoningEfforts: [],
    },
  ];
  const engine = new GatewayEngine(config, appServer);
  const imageBase64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  const result = await engine.ask({
    systemPrompt: 'Answer the supplied math question.',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Reply with the expected test answer.' },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${imageBase64}` } },
        ],
      },
    ],
    model: 'math-reader-zero-tool-probe',
  });
  assert.deepEqual(result, {
    text: 'runtime answer',
    model: 'math-reader-zero-tool-probe',
  });

  let captureTimeout;
  const captureTimedOut = new Promise((_, reject) => {
    captureTimeout = setTimeout(
      () => reject(new Error('Timed out waiting for the local Responses capture.')),
      15_000,
    );
  });
  let outbound;
  try {
    outbound = await Promise.race([capture, captureTimedOut]);
  } finally {
    clearTimeout(captureTimeout);
  }
  assert.equal(outbound.method, 'POST');
  assert.equal(outbound.url, '/v1/responses');
  assert.equal(outbound.headers.authorization, undefined, 'The fake provider must not receive credentials.');
  assert.deepEqual(outbound.body.tools, [], 'No model-executable tools may be advertised.');
  assert.deepEqual(
    findType(outbound.body, 'additional_tools'),
    [],
    'No additional_tools wrapper may be injected anywhere in the request.',
  );
  assert.equal(
    findType(outbound.body, 'input_image').length,
    1,
    'Local image input must remain available while all tools are disabled.',
  );

  let loaded;
  const unloadDeadline = Date.now() + 5_000;
  do {
    loaded = await appServer.request('thread/loaded/list', {});
    if (loaded?.data?.length === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  } while (Date.now() < unloadDeadline);
  assert.deepEqual(loaded?.data, [], 'The ephemeral engine thread must be unloaded after cleanup.');
});
