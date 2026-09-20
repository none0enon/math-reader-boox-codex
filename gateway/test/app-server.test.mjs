import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';

import {
  CodexAppServer,
  publicAuth,
  requireChatgptAccount,
} from '../app-server.mjs';
import { eventually, temporaryConfig, withTemporaryDirectory } from './helpers.mjs';

function fakeChild(onMessage) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.messages = [];
  let buffered = '';
  child.stdin = new Writable({
    write(chunk, _encoding, callback) {
      buffered += chunk.toString('utf8');
      let newline;
      while ((newline = buffered.indexOf('\n')) !== -1) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (!line) continue;
        const message = JSON.parse(line);
        child.messages.push(message);
        onMessage?.(message, child);
      }
      callback();
    },
  });
  child.reply = (id, result) => {
    child.stdout.write(`${JSON.stringify({ id, result })}\n`);
  };
  child.fail = (id, message) => {
    child.stdout.write(`${JSON.stringify({ id, error: { code: -1, message } })}\n`);
  };
  child.send = (message) => {
    child.stdout.write(`${JSON.stringify(message)}\n`);
  };
  child.killSignals = [];
  child.kill = (signal) => {
    child.killSignals.push(signal);
    if (child.exitCode === null) {
      child.exitCode = signal === 'SIGKILL' ? 137 : 0;
      child.signalCode = signal;
      queueMicrotask(() => child.emit('exit', child.exitCode, signal));
    }
    return true;
  };
  return child;
}

test('app-server client initializes, paginates models, and denies server tool requests', async () => {
  await withTemporaryDirectory('math-reader-app-server-', async (directory) => {
    let spawnCall;
    const child = fakeChild((message, process_) => {
      if (message.method === 'initialize') process_.reply(message.id, { userAgent: 'fake' });
      if (message.method === 'account/read') {
        process_.reply(message.id, {
          account: { type: 'chatgpt', email: 'person@example.test', planType: 'plus' },
        });
      }
      if (message.method === 'model/list') {
        if (message.params.cursor == null) {
          process_.reply(message.id, { data: [{ id: 'a' }], nextCursor: 'next' });
        } else {
          process_.reply(message.id, { data: [{ id: 'b' }], nextCursor: null });
        }
      }
    });
    const config = temporaryConfig(directory);
    const client = new CodexAppServer(config, {
      environment: {
        PATH: '/usr/bin',
        OPENAI_API_KEY: 'must-not-leak',
        CODEX_API_KEY: 'must-not-leak-either',
      },
      spawn(command, arguments_, options) {
        spawnCall = { command, arguments_, options };
        return child;
      },
    });

    await client.start();
    assert.equal(client.initialized, true);
    assert.equal(client.running, true);
    assert.equal(spawnCall.command, 'codex-test');
    assert.equal(spawnCall.options.cwd, config.workspaceDirectory);
    assert.equal(spawnCall.options.env.CODEX_HOME, config.codexHome);
    assert.equal(Object.hasOwn(spawnCall.options.env, 'OPENAI_API_KEY'), false);
    assert.equal(Object.hasOwn(spawnCall.options.env, 'CODEX_API_KEY'), false);
    assert.ok(spawnCall.arguments_.includes('--strict-config'));
    assert.deepEqual(child.messages.slice(0, 2).map((message) => message.method), [
      'initialize',
      'initialized',
    ]);

    assert.deepEqual(await client.readAccount(), {
      type: 'chatgpt',
      email: 'person@example.test',
      planType: 'plus',
    });
    assert.deepEqual((await client.listModels()).map((model) => model.id), ['a', 'b']);

    const blocked = [];
    client.on('blockedToolRequest', (event) => blocked.push(event));
    child.send({
      id: 900,
      method: 'item/commandExecution/requestApproval',
      params: { command: 'rm -rf something' },
    });
    child.send({ id: 901, method: 'item/tool/call', params: { tool: 'anything' } });
    child.send({ id: 902, method: 'item/tool/requestUserInput', params: { questions: [] } });
    await eventually(() => child.messages.some((message) => message.id === 902));

    assert.deepEqual(child.messages.find((message) => message.id === 900)?.result, {
      decision: 'cancel',
    });
    assert.deepEqual(child.messages.find((message) => message.id === 901)?.result, {
      success: false,
      contentItems: [{ type: 'inputText', text: 'Tools are disabled by this gateway.' }],
    });
    assert.equal(child.messages.find((message) => message.id === 902)?.error.code, -32601);
    assert.deepEqual(blocked.map((event) => event.method), [
      'item/commandExecution/requestApproval',
      'item/tool/call',
      'item/tool/requestUserInput',
    ]);

    await client.stop();
    assert.deepEqual(child.killSignals, ['SIGTERM']);
  });
});

test('initialization failure terminates the spawned app-server', async () => {
  await withTemporaryDirectory('math-reader-app-server-', async (directory) => {
    const child = fakeChild((message, process_) => {
      if (message.method === 'initialize') process_.fail(message.id, 'unsupported client');
    });
    const client = new CodexAppServer(temporaryConfig(directory), { spawn: () => child });
    await assert.rejects(client.start(), {
      code: 'codex_rpc_error',
      statusCode: 502,
      message: 'unsupported client',
    });
    assert.equal(client.running, false);
    assert.deepEqual(child.killSignals, ['SIGTERM']);
  });
});

test('raw app-server stderr stays out of public failure messages', async () => {
  await withTemporaryDirectory('math-reader-app-server-', async (directory) => {
    const child = fakeChild((message, process_) => {
      if (message.method === 'initialize') process_.reply(message.id, {});
    });
    const client = new CodexAppServer(temporaryConfig(directory), { spawn: () => child });
    await client.start();
    const pending = client.request('account/read');
    child.stderr.write('private-token-from-stderr');
    child.exitCode = 1;
    child.emit('exit', 1, null);
    await assert.rejects(pending, (error) => {
      assert.equal(error.code, 'codex_unavailable');
      assert.doesNotMatch(error.message, /private-token/);
      assert.match(error.cause?.message || '', /private-token/);
      return true;
    });
  });
});

test('an aborted RPC can consume a late result for resource cleanup', async () => {
  await withTemporaryDirectory('math-reader-app-server-', async (directory) => {
    const child = fakeChild((message, process_) => {
      if (message.method === 'initialize') process_.reply(message.id, {});
    });
    const client = new CodexAppServer(temporaryConfig(directory), { spawn: () => child });
    await client.start();
    const controller = new AbortController();
    let lateResult;
    const pending = client.request(
      'thread/start',
      { ephemeral: true },
      {
        signal: controller.signal,
        onLateResult(result) {
          lateResult = result;
        },
      },
    );
    const outbound = await eventually(() =>
      child.messages.find((message) => message.method === 'thread/start'),
    );
    controller.abort();
    await assert.rejects(pending, { code: 'request_cancelled', statusCode: 499 });

    child.reply(outbound.id, { thread: { id: 'late-thread' } });
    await eventually(() => lateResult);
    assert.deepEqual(lateResult, { thread: { id: 'late-thread' } });
    assert.equal(client.pending.size, 0);
    await client.stop();
  });
});

test('ChatGPT authentication is the only accepted account type', () => {
  assert.deepEqual(publicAuth(null), { type: 'none' });
  assert.deepEqual(publicAuth({ type: 'apiKey' }), { type: 'none' });
  assert.deepEqual(
    publicAuth({ type: 'chatgpt', email: 'person@example.test', planType: 'team' }),
    { type: 'chatgpt', email: 'person@example.test', planType: 'team' },
  );
  assert.throws(() => requireChatgptAccount({ type: 'apiKey' }), {
    code: 'chatgpt_login_required',
    statusCode: 503,
  });
  assert.throws(() => requireChatgptAccount(null), {
    code: 'chatgpt_login_required',
    statusCode: 503,
  });
  const account = { type: 'chatgpt' };
  assert.equal(requireChatgptAccount(account), account);
});
