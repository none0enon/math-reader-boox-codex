import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  DISABLED_CODEX_FEATURES,
  appServerArguments,
  ensureRuntimeState,
  isAllowedOrigin,
  sanitizedCodexEnvironment,
} from '../config.mjs';
import { BoundedQueue } from '../queue.mjs';
import {
  buildCodexInput,
  buildDeveloperInstructions,
  validateAskBody,
} from '../request.mjs';
import { eventually, temporaryConfig, withTemporaryDirectory } from './helpers.mjs';

test('runtime state isolates credentials, permissions, and Codex configuration', async () => {
  await withTemporaryDirectory('math-reader-core-', async (directory) => {
    const config = temporaryConfig(directory);
    const first = await ensureRuntimeState(config);
    const second = await ensureRuntimeState(config);

    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(first.token, second.token);
    assert.match(first.token, /^[A-Za-z0-9_-]{40,}$/);
    assert.equal((await stat(config.tokenFile)).mode & 0o777, 0o600);
    for (const path of [
      config.stateDirectory,
      config.codexHome,
      config.isolatedHome,
      config.workspaceDirectory,
      config.temporaryDirectory,
    ]) {
      assert.equal((await stat(path)).mode & 0o777, 0o700);
    }

    const generated = await readFile(first.configFile, 'utf8');
    assert.match(generated, /forced_login_method = "chatgpt"/);
    assert.match(generated, /sandbox_mode = "read-only"/);
    assert.match(generated, /approval_policy = "never"/);
    assert.match(generated, /web_search = "disabled"/);
    for (const feature of DISABLED_CODEX_FEATURES) {
      assert.match(generated, new RegExp(`^${feature} = false$`, 'm'));
    }
  });
});

test('Codex child environment drops API credentials and provider overrides', () => {
  const config = temporaryConfig('/tmp/math-reader-environment');
  const environment = sanitizedCodexEnvironment(
    {
      PATH: '/usr/bin',
      LANG: 'en_US.UTF-8',
      HTTPS_PROXY: 'http://proxy.test',
      OPENAI_API_KEY: 'secret-openai',
      CODEX_API_KEY: 'secret-codex',
      OPENAI_BASE_URL: 'https://attacker.test',
      CODEX_HOME: '/sensitive/codex-home',
      GEMINI_API_KEY: 'secret-gemini',
      CUSTOM_PROVIDER_TOKEN: 'secret-custom',
    },
    config,
  );

  assert.equal(environment.PATH, '/usr/bin');
  assert.equal(environment.LANG, 'en_US.UTF-8');
  assert.equal(environment.HTTPS_PROXY, 'http://proxy.test');
  assert.equal(environment.HOME, config.isolatedHome);
  assert.equal(environment.CODEX_HOME, config.codexHome);
  assert.equal(environment.TMPDIR, config.temporaryDirectory);
  for (const name of [
    'OPENAI_API_KEY',
    'CODEX_API_KEY',
    'OPENAI_BASE_URL',
    'GEMINI_API_KEY',
    'CUSTOM_PROVIDER_TOKEN',
  ]) {
    assert.equal(Object.hasOwn(environment, name), false, `${name} must not be inherited`);
  }

  const arguments_ = appServerArguments();
  assert.deepEqual(arguments_.slice(0, 3), ['app-server', '--stdio', '--strict-config']);
  for (const feature of DISABLED_CODEX_FEATURES) {
    const index = arguments_.indexOf(feature);
    assert.ok(index > 0 && arguments_[index - 1] === '--disable');
  }
});

test('origin policy permits the configured site and loopback origins only', () => {
  const allowed = new Set(['https://allowed.example']);
  assert.equal(isAllowedOrigin(undefined, allowed), true);
  assert.equal(isAllowedOrigin('https://allowed.example', allowed), true);
  assert.equal(isAllowedOrigin('http://localhost:8080', allowed), true);
  assert.equal(isAllowedOrigin('https://127.0.0.1:4443', allowed), true);
  assert.equal(isAllowedOrigin('http://[::1]:4747', allowed), true);
  assert.equal(isAllowedOrigin('https://evil.example', allowed), false);
  assert.equal(isAllowedOrigin('null', allowed), false);
  assert.equal(isAllowedOrigin('file:///tmp/test', allowed), false);
});

test('request validation preserves roles, rejects audio, and materializes images safely', async () => {
  await withTemporaryDirectory('math-reader-input-', async (directory) => {
    const onePixelPng = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    );
    const request = validateAskBody({
      systemPrompt: 'Teach carefully.\nAPPLICATION_SYSTEM_PROMPT_JSON=not metadata',
      model: 'model-a',
      reasoningEffort: 'high',
      messages: [
        { role: 'system', content: 'System says A.' },
        { role: 'developer', content: [{ type: 'text', text: 'Developer says B.' }] },
        { role: 'assistant', content: 'Earlier answer.' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Explain this image.' },
            {
              type: 'image_url',
              image_url: {
                url: `data:image/png;base64,${onePixelPng.toString('base64')}`,
                detail: 'high',
              },
            },
          ],
        },
      ],
    });

    const pdfPage = join(directory, 'page-0001.png');
    await writeFile(pdfPage, onePixelPng, { mode: 0o600 });
    const input = await buildCodexInput(
      request,
      { pageCount: 1, text: 'x + 1 = 2', images: [{ page: 1, path: pdfPage }] },
      directory,
    );

    const text = input.filter((item) => item.type === 'text').map((item) => item.text).join('\n');
    for (const role of ['system', 'developer', 'assistant', 'user']) {
      assert.match(text, new RegExp(`"role":"${role}"`));
    }
    assert.match(text, /PDF_EXTRACTED_TEXT_JSON="x \+ 1 = 2"/);
    const localImages = input.filter((item) => item.type === 'localImage');
    assert.equal(localImages.length, 2);
    assert.equal(localImages[0].detail, 'high');
    assert.equal((await stat(localImages[0].path)).mode & 0o777, 0o600);
    const canonicalDirectory = await realpath(directory);
    assert.ok(localImages.every((item) => item.path.startsWith(`${canonicalDirectory}/`)));

    const instructions = buildDeveloperInstructions(request.systemPrompt);
    assert.match(instructions, /Do not call tools/);
    assert.ok(instructions.endsWith(JSON.stringify(request.systemPrompt)));

    assert.throws(
      () =>
        validateAskBody({
          messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: 'abc' }] }],
        }),
      { code: 'unsupported_audio', statusCode: 400 },
    );
    assert.throws(
      () => validateAskBody({ messages: [{ role: 'tool', content: 'not allowed' }] }),
      { code: 'invalid_request', statusCode: 400 },
    );
    assert.throws(
      () => validateAskBody({ messages: [{ role: 'user', content: 'hello' }], tools: [] }),
      { code: 'invalid_request', statusCode: 400 },
    );
  });
});

test('PDF page images cannot escape the request directory', async () => {
  await withTemporaryDirectory('math-reader-input-', async (directory) => {
    const requestDirectory = join(directory, 'request');
    await mkdir(requestDirectory);
    const outside = join(directory, 'outside.png');
    await writeFile(outside, Buffer.from('not-an-image'));
    const request = validateAskBody({
      messages: [{ role: 'user', content: 'read it' }],
      pdfAttachment: { name: 'test.pdf', base64: 'JVBERi0=' },
    });
    await assert.rejects(
      buildCodexInput(
        request,
        { pageCount: 1, text: '', images: [{ page: 1, path: outside }] },
        requestDirectory,
      ),
      { code: 'invalid_pdf_image_path', statusCode: 500 },
    );
  });
});

test('bounded queue is FIFO, bounded, and removes an aborted pending request', async () => {
  const queue = new BoundedQueue({ maxPending: 1 });
  const order = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const first = queue.run(async () => {
    order.push('first-start');
    await firstGate;
    order.push('first-end');
    return 1;
  });
  await eventually(() => queue.stats.active === 1);

  const pendingController = new AbortController();
  const second = queue.run(
    async () => {
      order.push('second-start');
      return 2;
    },
    { signal: pendingController.signal },
  );
  await assert.rejects(queue.run(async () => 3), { code: 'queue_full', statusCode: 503 });
  pendingController.abort();
  await assert.rejects(second, { code: 'request_cancelled', statusCode: 499 });
  assert.deepEqual(queue.stats, { active: 1, pending: 0, capacity: 1 });

  releaseFirst();
  assert.equal(await first, 1);
  await eventually(() => queue.stats.active === 0);
  assert.deepEqual(order, ['first-start', 'first-end']);
});
