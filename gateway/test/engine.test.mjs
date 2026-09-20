import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, readdir } from 'node:fs/promises';

import { GatewayEngine } from '../engine.mjs';
import { GatewayError, abortError } from '../errors.mjs';
import { eventually, temporaryConfig, withTemporaryDirectory } from './helpers.mjs';

const IMAGE_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

function defaultModel(overrides = {}) {
  return {
    model: 'codex-smart',
    displayName: 'Codex Smart',
    isDefault: true,
    hidden: false,
    inputModalities: ['text', 'image'],
    supportedReasoningEfforts: [
      { reasoningEffort: 'medium' },
      { reasoningEffort: 'high' },
    ],
    ...overrides,
  };
}

class FakeAppServer extends EventEmitter {
  constructor(options = {}) {
    super();
    this.running = true;
    this.initialized = true;
    this.account = options.account ?? {
      type: 'chatgpt',
      email: 'reader@example.test',
      planType: 'plus',
    };
    this.catalog = options.catalog ?? [defaultModel()];
    this.onThreadStart = options.onThreadStart || null;
    this.onTurnStart = options.onTurnStart || null;
    this.calls = [];
  }

  async start() {
    this.running = true;
    this.initialized = true;
  }

  async stop() {
    this.running = false;
    this.initialized = false;
  }

  async readAccount(options = {}) {
    if (options.signal?.aborted) throw abortError(options.signal);
    this.calls.push({ method: 'account/read', params: { refreshToken: options.refreshToken } });
    return this.account;
  }

  async listModels({ signal } = {}) {
    if (signal?.aborted) throw abortError(signal);
    this.calls.push({ method: 'model/list', params: {} });
    return this.catalog;
  }

  async request(method, params = {}, options = {}) {
    if (options.signal?.aborted) throw abortError(options.signal);
    this.calls.push({ method, params, options });
    switch (method) {
      case 'thread/start':
        if (this.onThreadStart) return this.onThreadStart(params, this, options);
        return { thread: { id: 'thread-1' } };
      case 'turn/start': {
        const response = { turn: { id: 'turn-1' } };
        this.onTurnStart?.(params, this);
        return response;
      }
      case 'turn/interrupt':
      case 'thread/unsubscribe':
        return {};
      default:
        throw new Error(`Unexpected fake request: ${method}`);
    }
  }
}

function askBody(overrides = {}) {
  return {
    systemPrompt: 'Explain each step.',
    messages: [
      { role: 'system', content: 'Use exact notation.' },
      { role: 'assistant', content: 'What have you tried?' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Solve the pictured equation.' },
          { type: 'image_url', image_url: { url: IMAGE_DATA_URL, detail: 'high' } },
        ],
      },
    ],
    reasoningEffort: 'high',
    ...overrides,
  };
}

async function configuredEngine(directory, appServer, overrides = {}) {
  const config = temporaryConfig(directory, overrides);
  await mkdir(config.temporaryDirectory, { recursive: true, mode: 0o700 });
  return { config, engine: new GatewayEngine(config, appServer) };
}

test('engine maps a conversation to a locked-down ephemeral Codex turn and cleans it up', async () => {
  await withTemporaryDirectory('math-reader-engine-', async (directory) => {
    const appServer = new FakeAppServer({
      onTurnStart(_params, server) {
        setImmediate(() => {
          server.emit('notification', {
            method: 'item/completed',
            params: {
              threadId: 'thread-1',
              turnId: 'turn-1',
              item: { type: 'agentMessage', phase: 'final_answer', text: 'x = 3' },
            },
          });
          server.emit('notification', {
            method: 'turn/completed',
            params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', items: [] } },
          });
        });
      },
    });
    const { config, engine } = await configuredEngine(directory, appServer);
    const result = await engine.ask(askBody());
    assert.deepEqual(result, { text: 'x = 3', model: 'codex-smart' });

    const threadStart = appServer.calls.find((call) => call.method === 'thread/start');
    assert.equal(threadStart.params.cwd, config.workspaceDirectory);
    assert.equal(threadStart.params.ephemeral, true);
    assert.equal(threadStart.params.sandbox, 'read-only');
    assert.equal(threadStart.params.approvalPolicy, 'never');
    assert.equal(threadStart.params.personality, 'none');
    assert.equal(threadStart.params.config.web_search, 'disabled');
    assert.ok(
      Object.entries(threadStart.params.config.features)
        .filter(([name]) => name !== 'skip_host_skill_discovery')
        .every(([, enabled]) => enabled === false),
    );
    assert.match(threadStart.params.developerInstructions, /Do not call tools/);

    const turnStart = appServer.calls.find((call) => call.method === 'turn/start');
    assert.equal(turnStart.params.model, 'codex-smart');
    assert.equal(turnStart.params.effort, 'high');
    assert.ok(turnStart.params.input.some((item) => item.type === 'localImage'));
    const serialized = turnStart.params.input
      .filter((item) => item.type === 'text')
      .map((item) => item.text)
      .join('\n');
    assert.match(serialized, /"role":"system"/);
    assert.match(serialized, /"role":"assistant"/);
    assert.match(serialized, /"role":"user"/);

    assert.equal(
      appServer.calls.filter((call) => call.method === 'thread/unsubscribe').length,
      1,
    );
    assert.deepEqual(await readdir(config.temporaryDirectory), []);
  });
});

test('engine refuses API-key auth and validates model capabilities before creating a thread', async () => {
  await withTemporaryDirectory('math-reader-engine-', async (directory) => {
    const apiKeyServer = new FakeAppServer({ account: { type: 'apiKey' } });
    const { engine: apiKeyEngine } = await configuredEngine(directory, apiKeyServer);
    await assert.rejects(apiKeyEngine.models(), {
      code: 'chatgpt_login_required',
      statusCode: 503,
    });
    await assert.rejects(apiKeyEngine.ask(askBody()), {
      code: 'chatgpt_login_required',
      statusCode: 503,
    });
    assert.equal(apiKeyServer.calls.some((call) => call.method === 'thread/start'), false);
    const status = await apiKeyEngine.status();
    assert.equal(status.ready, false);
    assert.deepEqual(status.auth, { type: 'none' });
    assert.equal(status.authError, 'api_key_auth_refused');

    const capabilityServer = new FakeAppServer({
      catalog: [defaultModel({ inputModalities: ['text'] })],
    });
    const { engine } = await configuredEngine(directory, capabilityServer);
    await assert.rejects(engine.ask(askBody({ model: 'missing-model' })), {
      code: 'invalid_model',
      statusCode: 400,
    });
    await assert.rejects(engine.ask(askBody()), {
      code: 'invalid_model',
      statusCode: 400,
      message: 'The selected Codex model does not accept images.',
    });
    await assert.rejects(
      engine.ask(
        askBody({
          messages: [{ role: 'user', content: 'text only' }],
          reasoningEffort: 'ultra',
        }),
      ),
      { code: 'invalid_reasoning_effort', statusCode: 400 },
    );
    assert.equal(capabilityServer.calls.some((call) => call.method === 'thread/start'), false);
  });
});

test('abort rejects immediately, interrupts and unsubscribes the turn, and frees the queue', async () => {
  await withTemporaryDirectory('math-reader-engine-', async (directory) => {
    const appServer = new FakeAppServer();
    const { engine } = await configuredEngine(directory, appServer);
    const controller = new AbortController();
    const pending = engine.ask(
      askBody({ messages: [{ role: 'user', content: 'wait forever' }], reasoningEffort: 'medium' }),
      { signal: controller.signal },
    );
    await eventually(() => appServer.calls.some((call) => call.method === 'turn/start'));
    controller.abort(new GatewayError('request_timeout', 'The request timed out.', 504));

    await assert.rejects(
      Promise.race([
        pending,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('engine cancellation hung')), 500),
        ),
      ]),
      { code: 'request_timeout', statusCode: 504 },
    );
    await eventually(() => appServer.calls.some((call) => call.method === 'turn/interrupt'));
    assert.ok(appServer.calls.some((call) => call.method === 'thread/unsubscribe'));
    await eventually(() => engine.queue.stats.active === 0);
  });
});

test('observed tool activity fails closed and interrupts the turn', async () => {
  await withTemporaryDirectory('math-reader-engine-', async (directory) => {
    const appServer = new FakeAppServer();
    const { engine } = await configuredEngine(directory, appServer);
    const pending = engine.ask(
      askBody({ messages: [{ role: 'user', content: 'Use a command.' }], reasoningEffort: 'medium' }),
    );
    await eventually(() => appServer.calls.some((call) => call.method === 'turn/start'));
    appServer.emit('notification', {
      method: 'item/started',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: { type: 'commandExecution', command: 'anything' },
      },
    });

    await assert.rejects(pending, { code: 'tool_use_blocked', statusCode: 502 });
    assert.ok(appServer.calls.some((call) => call.method === 'turn/interrupt'));
    assert.ok(appServer.calls.some((call) => call.method === 'thread/unsubscribe'));
  });
});

test('abort during thread creation unsubscribes a thread returned after cancellation', async () => {
  await withTemporaryDirectory('math-reader-engine-', async (directory) => {
    const appServer = new FakeAppServer({
      onThreadStart(_params, _server, options) {
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener(
            'abort',
            () => {
              reject(abortError(options.signal));
              setImmediate(() => options.onLateResult({ thread: { id: 'late-thread' } }));
            },
            { once: true },
          );
        });
      },
    });
    const { engine } = await configuredEngine(directory, appServer);
    const controller = new AbortController();
    const pending = engine.ask(
      askBody({ messages: [{ role: 'user', content: 'cancel me' }], reasoningEffort: 'medium' }),
      { signal: controller.signal },
    );
    await eventually(() => appServer.calls.some((call) => call.method === 'thread/start'));
    controller.abort();
    await assert.rejects(pending, { code: 'request_cancelled', statusCode: 499 });
    await eventually(() =>
      appServer.calls.some(
        (call) =>
          call.method === 'thread/unsubscribe' && call.params.threadId === 'late-thread',
      ),
    );
  });
});
