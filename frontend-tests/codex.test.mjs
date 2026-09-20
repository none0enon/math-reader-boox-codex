import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const gateway = require('../app/src/main/assets/www/codex-gateway.js');

function jsonResponse(data, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => JSON.stringify(data)
    };
}

function sourceBetween(source, startMarker, endMarker) {
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker, start + startMarker.length);
    assert.notEqual(start, -1, 'missing start marker: ' + startMarker);
    assert.notEqual(end, -1, 'missing end marker: ' + endMarker);
    return source.slice(start, end).trim();
}

async function createRoutingHarness(overrides = {}) {
    const index = await readFile(new URL('../app/src/main/assets/www/index.html', import.meta.url), 'utf8');
    const snippets = [
        sourceBetween(index, 'function isGeminiUrl(', 'function _configuredGeminiRecordingConfig('),
        sourceBetween(index, 'function _configuredGeminiRecordingConfigs(', 'async function fetchModels('),
        sourceBetween(index, 'async function callAI(', 'async function doCodexGatewayRequest('),
        sourceBetween(index, 'async function doConfiguredGeminiAudioRequest(', 'async function doAIRequest('),
        sourceBetween(index, 'function isOutlineTokenLimitError(', 'function buildOutlinePageRanges(')
    ];
    const calls = { codex: [], gemini: [], legacy: [], toasts: [] };
    const context = vm.createContext({
        appData: { settings: {} },
        codexGatewayModule: () => gateway,
        doCodexGatewayRequest: async (...args) => {
            calls.codex.push(args);
            return 'codex-result';
        },
        doGeminiRequest: async (...args) => {
            calls.gemini.push(args);
            return 'gemini-result';
        },
        doAIRequest: async (...args) => {
            calls.legacy.push(args);
            return 'legacy-result';
        },
        showToast: value => calls.toasts.push(value),
        i18n: key => key,
        console: { error() {}, warn() {}, log() {} },
        ...overrides
    });
    vm.runInContext(snippets.join('\n\n'), context);
    return { context, calls };
}

test('Gateway URL permits HTTPS and browser loopback HTTP only', () => {
    assert.equal(gateway.normalizeBaseUrl('https://example.test/gateway/'), 'https://example.test/gateway');
    assert.equal(gateway.normalizeBaseUrl('http://127.0.0.1:8765/'), 'http://127.0.0.1:8765');
    assert.equal(gateway.normalizeBaseUrl('http://localhost:8765'), 'http://localhost:8765');
    assert.throws(
        () => gateway.normalizeBaseUrl('http://192.168.1.4:8765'),
        error => error.code === 'codex_gateway_https_required'
    );
    assert.throws(
        () => gateway.normalizeBaseUrl('http://127.0.0.1:8765', { requireHttps: true }),
        error => error.code === 'codex_gateway_https_required_boox'
    );
});

test('message serialization preserves complete text/image history and ordering', () => {
    const imageOne = 'data:image/png;base64,AQID';
    const imageTwo = 'data:image/jpeg;base64,BAUG';
    const input = [
        { role: 'user', content: 'first question' },
        { role: 'assistant', content: 'first answer' },
        {
            role: 'user',
            content: [
                { type: 'text', text: 'before image' },
                { type: 'image_url', image_url: { url: imageOne } },
                { type: 'text', text: 'between images' },
                { type: 'image_url', image_url: { url: imageTwo } }
            ]
        }
    ];

    assert.deepEqual(gateway.serializeMessages(input), input);
});

test('audio is detected and cannot be silently sent to Codex', async () => {
    const messages = [{
        role: 'user',
        content: [{ type: 'audio', audio: { data: 'AA==', mimeType: 'audio/wav' } }]
    }];
    assert.equal(gateway.hasAudioContent(messages), true);
    await assert.rejects(
        gateway.buildAskPayload({ messages }),
        error => error.code === 'codex_audio_not_supported'
    );
});

test('PDF serialization includes every input byte without truncation', async () => {
    const bytes = Uint8Array.from({ length: 128 * 1024 }, (_, index) => index % 251);
    const serialized = await gateway.serializePdfAttachment({ bytes, name: 'full.pdf' });
    const roundTrip = Buffer.from(serialized.base64, 'base64');
    assert.equal(serialized.name, 'full.pdf');
    assert.equal(roundTrip.length, bytes.length);
    assert.deepEqual(roundTrip, Buffer.from(bytes));
});

test('ask sends Bearer auth and the exact Gateway contract', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
        calls.push({ url, init });
        return jsonResponse({ text: 'answer', model: 'codex-test' });
    };
    const image = 'data:image/png;base64,AQIDBA==';
    const result = await gateway.ask(
        { baseUrl: 'https://gateway.test/base/', token: 'secret-token' },
        {
            systemPrompt: 'system',
            messages: [{ role: 'user', content: [
                { type: 'text', text: 'question' },
                { type: 'image_url', image_url: { url: image } }
            ] }],
            model: 'codex-test',
            reasoningEffort: 'high',
            pdfAttachment: { bytes: new Uint8Array([1, 2, 3, 4]), name: 'book.pdf' }
        },
        { fetchImpl }
    );

    assert.deepEqual(result, { text: 'answer', model: 'codex-test' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://gateway.test/base/v1/ask');
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer secret-token');
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.systemPrompt, 'system');
    assert.equal(body.model, 'codex-test');
    assert.equal(body.reasoningEffort, 'high');
    assert.deepEqual(body.messages[0].content[1], {
        type: 'image_url', image_url: { url: image }
    });
    assert.deepEqual(Buffer.from(body.pdfAttachment.base64, 'base64'), Buffer.from([1, 2, 3, 4]));
});

test('models and status use authenticated endpoints', async () => {
    const calls = [];
    const responses = [
        jsonResponse({ ready: true, auth: { type: 'chatgpt' } }),
        jsonResponse({ data: [{ id: 'model-a', name: 'Model A', reasoningEfforts: ['low', 'high'] }] })
    ];
    const fetchImpl = async (url, init) => {
        calls.push({ url, init });
        return responses.shift();
    };
    const config = { baseUrl: 'https://gateway.test', token: 'token' };
    const status = await gateway.getStatus(config, { fetchImpl });
    const models = await gateway.listModels(config, { fetchImpl });
    assert.equal(status.ready, true);
    assert.deepEqual(models, [{ id: 'model-a', name: 'Model A', reasoningEfforts: ['low', 'high'] }]);
    assert.deepEqual(calls.map(call => call.url), [
        'https://gateway.test/v1/status',
        'https://gateway.test/v1/models'
    ]);
    assert.ok(calls.every(call => call.init.headers.Authorization === 'Bearer token'));
});

test('structured Gateway errors retain code and HTTP status for outline chunk fallback', async () => {
    const fetchImpl = async () => jsonResponse({
        error: { code: 'context_length_exceeded', message: 'PDF has more than 48 pages' }
    }, 413);
    let receivedError;
    await assert.rejects(
        gateway.ask(
            { baseUrl: 'https://gateway.test', token: 'token' },
            { systemPrompt: '', messages: [] },
            { fetchImpl }
        ),
        error => {
            receivedError = error;
            return error.code === 'context_length_exceeded' &&
                error.status === 413 && /context_length_exceeded/.test(error.message);
        }
    );
    const { context } = await createRoutingHarness();
    assert.equal(context.isOutlineTokenLimitError(receivedError), true);
});

test('Gateway body-size 413 errors trigger outline chunk fallback', async () => {
    const fetchImpl = async () => jsonResponse({
        error: { code: 'request_too_large', message: 'The JSON request body is too large.' }
    }, 413);
    let receivedError;
    await assert.rejects(
        gateway.ask(
            { baseUrl: 'https://gateway.test', token: 'token' },
            { systemPrompt: '', messages: [] },
            { fetchImpl }
        ),
        error => {
            receivedError = error;
            return error.code === 'request_too_large' && error.status === 413;
        }
    );
    const { context } = await createRoutingHarness();
    assert.equal(context.isOutlineTokenLimitError(receivedError), true);
    assert.equal(context.isOutlineTokenLimitError({ code: 'codex_gateway_http_413', status: 413 }), true);
    assert.equal(context.isOutlineTokenLimitError({ code: 'unrelated', status: 400 }), false);
});

test('request timeout is capped at ten minutes and aborts cleanly', async () => {
    assert.equal(gateway.MAX_REQUEST_TIMEOUT_MS, 600000);
    const fetchImpl = async (_url, init) => new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
    await assert.rejects(
        gateway.getStatus(
            { baseUrl: 'https://gateway.test', token: 'token' },
            { fetchImpl, timeoutMs: 1 }
        ),
        error => error.code === 'codex_gateway_timeout'
    );
});

test('frontend wiring keeps Codex local-only and routes by modality', async () => {
    const index = await readFile(new URL('../app/src/main/assets/www/index.html', import.meta.url), 'utf8');
    assert.match(index, /'codexEnabled', 'codexGatewayUrl', 'codexGatewayToken'/);
    assert.match(index, /if \(s\.codexEnabled\)[\s\S]*hasAudioContent\(messages\)/);
    assert.match(index, /return await doCodexGatewayRequest\(systemPrompt, messages, options\)/);
    assert.match(index, /return await doConfiguredGeminiAudioRequest\(systemPrompt, messages, options\)/);
    assert.match(index, /settings\.codexGatewayUrl \|\| '', settings\.codexModel \|\| ''/);
    assert.match(index, /<div class="toggle-switch" id="codexEnabledToggle" role="switch"/);
    assert.match(index, /\.toggle-switch\.on \.toggle-thumb\s*\{\s*left:\s*22px;/);
});

test('PWA and packaged web assets stay byte-identical, including the service worker', async () => {
    const assetPairs = [
        ['index.html', 'index.html'],
        ['codex-gateway.js', 'codex-gateway.js'],
        ['sw.js', 'sw.js']
    ];
    for (const [assetName, docsName] of assetPairs) {
        const [packaged, docs] = await Promise.all([
            readFile(new URL('../app/src/main/assets/www/' + assetName, import.meta.url)),
            readFile(new URL('../docs/' + docsName, import.meta.url))
        ]);
        assert.deepEqual(docs, packaged, assetName + ' differs between app assets and docs');
    }
});

test('actual callAI routes full non-audio requests exclusively to Codex', async () => {
    const { context, calls } = await createRoutingHarness();
    context.appData.settings = {
        codexEnabled: true,
        aiApiUrl: 'https://generativelanguage.googleapis.com/v1beta',
        aiApiKey: 'gemini-key',
        aiModel: 'gemini-model',
        apiProvider: 'google'
    };
    const messages = [{ role: 'user', content: [
        { type: 'text', text: 'read all inputs' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AQID' } }
    ] }];
    const pdfAttachment = { bytes: new Uint8Array([1, 2, 3]), name: 'book.pdf' };
    assert.equal(await context.callAI('system', messages, { pdfAttachment }), 'codex-result');
    assert.equal(calls.codex.length, 1);
    assert.equal(calls.codex[0][0], 'system');
    assert.deepEqual(calls.codex[0][1], messages);
    assert.equal(calls.codex[0][2].pdfAttachment, pdfAttachment);
    assert.equal(calls.gemini.length, 0);
    assert.equal(calls.legacy.length, 0);
});

test('actual audio routing selects configured Gemini primary or backup only', async () => {
    const { context, calls } = await createRoutingHarness();
    const audioMessages = [{ role: 'user', content: [
        { type: 'audio', audio: { data: 'AA==', mimeType: 'audio/wav' } }
    ] }];

    context.appData.settings = {
        codexEnabled: true,
        apiProvider: 'google',
        aiApiUrl: 'https://generativelanguage.googleapis.com/v1beta',
        aiApiKey: 'primary-key',
        aiModel: 'primary-gemini',
        backupProvider: 'google',
        backupUrl: 'https://generativelanguage.googleapis.com/v1beta',
        backupKey: 'backup-key',
        backupModel: 'backup-gemini'
    };
    assert.equal(await context.callAI('audio', audioMessages, {}), 'gemini-result');
    assert.equal(calls.gemini[0][0].key, 'primary-key');

    calls.gemini.length = 0;
    context.appData.settings = {
        codexEnabled: true,
        apiProvider: 'deepseek',
        aiApiUrl: 'https://api.deepseek.com/v1/chat/completions',
        aiApiKey: 'not-gemini',
        aiModel: 'deepseek-chat',
        backupProvider: 'google',
        backupUrl: 'https://generativelanguage.googleapis.com/v1beta',
        backupKey: 'backup-only-key',
        backupModel: 'backup-gemini'
    };
    assert.equal(await context.callAI('audio', audioMessages, {}), 'gemini-result');
    assert.equal(calls.gemini.length, 1);
    assert.equal(calls.gemini[0][0].key, 'backup-only-key');
    assert.equal(calls.codex.length, 0);
    assert.equal(calls.legacy.length, 0);
});

test('actual audio routing retries a second configured Gemini endpoint', async () => {
    let attempts = 0;
    const { context, calls } = await createRoutingHarness({
        doGeminiRequest: async (...args) => {
            calls.gemini.push(args);
            attempts++;
            if (attempts === 1) throw new Error('primary unavailable');
            return 'backup-gemini-result';
        }
    });
    context.appData.settings = {
        codexEnabled: true,
        apiProvider: 'google', aiApiUrl: 'https://generativelanguage.googleapis.com/v1beta',
        aiApiKey: 'first', aiModel: 'gemini-first',
        backupProvider: 'custom', backupUrl: 'https://gemini-proxy.test/v1beta',
        backupKey: 'second', backupModel: 'gemini-second'
    };
    const messages = [{ role: 'user', content: [{ type: 'audio', audio: { data: 'AA==' } }] }];
    assert.equal(await context.callAI('audio', messages, {}), 'backup-gemini-result');
    assert.deepEqual(calls.gemini.map(call => call[0].key), ['first', 'second']);
    assert.equal(calls.toasts.length, 1);
});

test('actual callAI reports missing Gemini for audio while Codex is enabled', async () => {
    const { context, calls } = await createRoutingHarness();
    context.appData.settings = {
        codexEnabled: true,
        apiProvider: 'deepseek', aiApiUrl: 'https://api.deepseek.com/v1/chat/completions',
        aiApiKey: 'key', aiModel: 'deepseek-chat'
    };
    const messages = [{ role: 'user', content: [{ type: 'audio', audio: { data: 'AA==' } }] }];
    await assert.rejects(context.callAI('audio', messages, {}), /codex_audio_requires_gemini/);
    assert.equal(calls.codex.length, 0);
    assert.equal(calls.gemini.length, 0);
    assert.equal(calls.legacy.length, 0);
});

test('Codex failure never falls back to legacy primary or backup APIs', async () => {
    const gatewayFailure = new Error('gateway failed');
    const { context, calls } = await createRoutingHarness({
        doCodexGatewayRequest: async (...args) => {
            calls.codex.push(args);
            throw gatewayFailure;
        }
    });
    context.appData.settings = {
        codexEnabled: true,
        aiApiUrl: 'https://api.deepseek.com/v1/chat/completions', aiApiKey: 'primary', aiModel: 'primary',
        backupUrl: 'https://backup.test/chat/completions', backupKey: 'backup', backupModel: 'backup'
    };
    await assert.rejects(context.callAI('system', [{ role: 'user', content: 'hello' }], {}),
        error => error === gatewayFailure);
    assert.equal(calls.codex.length, 1);
    assert.equal(calls.legacy.length, 0);
    assert.equal(calls.gemini.length, 0);
});

test('disabling Codex preserves the existing primary and backup routing', async () => {
    let attempts = 0;
    const { context, calls } = await createRoutingHarness({
        doAIRequest: async (...args) => {
            calls.legacy.push(args);
            attempts++;
            if (attempts === 1) throw new Error('primary failed');
            return 'legacy-backup-result';
        }
    });
    context.appData.settings = {
        codexEnabled: false,
        apiProvider: 'deepseek', aiApiUrl: 'https://primary.test/chat/completions',
        aiApiKey: 'primary', aiModel: 'primary-model',
        backupProvider: 'openai', backupUrl: 'https://backup.test/chat/completions',
        backupKey: 'backup', backupModel: 'backup-model'
    };
    assert.equal(
        await context.callAI('system', [{ role: 'user', content: 'hello' }], {}),
        'legacy-backup-result'
    );
    assert.deepEqual(calls.legacy.map(call => call[0].key), ['primary', 'backup']);
    assert.equal(calls.codex.length, 0);
    assert.equal(calls.gemini.length, 0);
});
