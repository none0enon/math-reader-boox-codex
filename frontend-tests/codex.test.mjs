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
        sourceBetween(index, 'const OUTLINE_PDF_CHUNK_MAX_PAGES', 'function isPlaceholderPdfBookmark('),
        sourceBetween(index, 'function isGeminiUrl(', 'function _configuredGeminiRecordingConfig('),
        sourceBetween(index, 'function _configuredGeminiRecordingConfigs(', 'async function fetchModels('),
        sourceBetween(index, 'async function callAI(', 'async function doCodexGatewayRequest('),
        sourceBetween(index, 'async function doConfiguredGeminiAudioRequest(', 'async function doAIRequest('),
        sourceBetween(index, 'function isOutlineTokenLimitError(', 'function buildOutlinePageRanges('),
        sourceBetween(index, 'function buildOutlinePageRanges(', 'function outlineDraftSignature(')
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

async function createExerciseGradingParserHarness() {
    const index = await readFile(new URL('../app/src/main/assets/www/index.html', import.meta.url), 'utf8');
    const parserSource = sourceBetween(
        index,
        'function robustParseJSONObject(',
        'function splitQuestionsByNumber('
    );
    const context = vm.createContext({
        i18n: key => key,
        console: { warn() {} }
    });
    vm.runInContext(parserSource, context);
    return { context, index, parserSource };
}

async function createGradeAllHarness(aiResult, { codexEnabled = true } = {}) {
    const index = await readFile(new URL('../app/src/main/assets/www/index.html', import.meta.url), 'utf8');
    const snippets = [
        sourceBetween(index, 'function robustParseJSONObject(', 'function splitQuestionsByNumber('),
        sourceBetween(index, 'async function gradeAllExQuestions(', 'async function exportExTaskAsPDF(')
    ];
    const question = { index: 0, latex: 'x+1=3', status: 'pending', score: null };
    const data = {
        folders: [{ id: 'folder', tasks: [{ id: 'task', name: 'Task', questions: [question] }] }],
        wrongByFolder: {}
    };
    const calls = { pageSaves: 0, wrongUpserts: 0, metadataSaves: 0, failedCommits: 0 };
    const context = vm.createContext({
        appData: { settings: { codexEnabled } },
        closeLongPressMenu() {},
        getExercisesData: () => data,
        showToast() {},
        i18n: (key, ...args) => [key, ...args].join(':'),
        confirm: () => true,
        exIssueQuestionGradingToken: () => 'token',
        exQuestionGradingGuard: () => () => true,
        exCollectQuestionDrawingPages: async () => ({
            allPages: ['data:image/png;base64,AA=='],
            gradingPages: ['data:image/png;base64,AA==']
        }),
        exGradingContent: () => [],
        callAI: async () => aiResult,
        exSaveGradedPages: async () => {
            calls.pageSaves++;
            return true;
        },
        exCreateGradedDrawingCommitId: () => 'commit',
        exStageGradedPagesCloudCommit: () => ({ id: 'cloud-commit' }),
        exUpsertWrongQuestion: () => { calls.wrongUpserts++; },
        saveData: () => {
            calls.metadataSaves++;
            return true;
        },
        exWaitForExercisesDataSaves: async () => true,
        exCommitGradedPagesCloudCommit() {},
        exFailGradedPagesCloudCommit: () => { calls.failedCommits++; },
        renderExerciseFolderContent() {},
        console: { error() {}, warn() {} }
    });
    vm.runInContext(snippets.join('\n\n'), context);
    return { context, calls, data, question };
}

async function createSingleQuestionGradingHarness(aiResult) {
    const index = await readFile(new URL('../app/src/main/assets/www/index.html', import.meta.url), 'utf8');
    const snippets = [
        sourceBetween(index, 'function robustParseJSONObject(', 'function splitQuestionsByNumber('),
        sourceBetween(index, 'async function exCompleteQuestionNow(', '// Wrong exercises folder')
    ];
    const question = { index: 0, latex: 'x+1=3', status: 'pending', score: null };
    const expectedState = {
        folderId: 'folder',
        taskId: 'task',
        questionIndex: 0,
        isWrong: false,
        questions: [question]
    };
    const calls = { metadataSaves: 0, wrongUpserts: 0, failedCommits: 0 };
    const context = vm.createContext({
        appData: { settings: { codexEnabled: true } },
        exDoingState: expectedState,
        exTimerStartedAt: null,
        exTimerSeconds: 0,
        exTimerInterval: null,
        exCompleteGenerationGuard: () => () => true,
        exWaitForDrawingRestore: async () => true,
        exWaitForPendingDrawingSaves: async () => true,
        exCollectPageImages: () => ['data:image/png;base64,AA=='],
        exIssueQuestionGradingToken: () => 'token',
        exQuestionGradingGuard: () => () => true,
        saveCurrentDrawingToCache: async () => true,
        exDropBlankPages: async pages => pages,
        showToast() {},
        i18n: (key, ...args) => [key, ...args].join(':'),
        exGradingContent: () => [],
        callAI: async () => aiResult,
        exFailGradedPagesCloudCommit: () => { calls.failedCommits++; },
        saveData: () => {
            calls.metadataSaves++;
            return true;
        },
        exUpsertWrongQuestion: () => { calls.wrongUpserts++; },
        console: { error() {}, warn() {} }
    });
    vm.runInContext(snippets.join('\n\n'), context);
    return { context, calls, expectedState, question };
}

async function createNotebookReviewGradingHarness(aiResult, { codexEnabled = true } = {}) {
    const index = await readFile(new URL('../app/src/main/assets/www/index.html', import.meta.url), 'utf8');
    const snippets = [
        sourceBetween(index, 'function robustParseJSONObject(', 'function splitQuestionsByNumber('),
        sourceBetween(
            index,
            'function parseNotebookReviewGradingResponse(',
            '// 完成 Quiz：截取画布'
        ),
        "let qzCurrentReviewId = 'review'; let qzCurrentQuizId = 'quiz';",
        sourceBetween(
            index,
            'async function nbCompleteQuizFs(',
            '// Quiz 评分完成后推进复习流程'
        )
    ];
    const quiz = {
        id: 'quiz',
        content: '1. Solve x + 1 = 3.',
        completedAt: null,
        score: null
    };
    const review = {
        id: 'review',
        pageId: 'page',
        stage: 0,
        extra: 0,
        status: 'pending',
        quizzes: [quiz]
    };
    const button = { disabled: false, textContent: 'done' };
    const canvas = { width: 100, height: 100 };
    const calls = {
        draftSaves: 0,
        touches: 0,
        saves: 0,
        renders: 0,
        updates: 0,
        syncs: 0,
        shows: 0,
        advances: 0,
        toasts: []
    };
    const context = vm.createContext({
        appData: { settings: { codexEnabled } },
        nbData: () => ({ reviews: [review] }),
        nbSaveQuizDraftToReview: () => {
            calls.draftSaves++;
            return true;
        },
        getQzCanvasDataURL: () => 'data:image/png;base64,ANSWER',
        document: {
            createElement: () => ({ toDataURL: () => 'data:image/png;base64,BLANK' }),
            getElementById: id => id === 'nbQuizFsCompleteBtn' ? button :
                (id === 'nbQuizFsCanvas' ? canvas : null)
        },
        callAI: async () => aiResult,
        i18n: (key, ...args) => [key, ...args].join(':'),
        showToast: value => calls.toasts.push(value),
        nbTouchReview: () => { calls.touches++; },
        saveData: () => { calls.saves++; },
        renderNbReviewList: () => { calls.renders++; },
        nbUpdateReviewBtn: () => { calls.updates++; },
        triggerSyncOnFileChange: () => { calls.syncs++; },
        nbShowQuiz: () => { calls.shows++; },
        nbAdvanceReviewAfterQuiz: () => { calls.advances++; },
        nbCloseQuizFullscreen() {},
        console: { error() {}, warn() {} }
    });
    vm.runInContext(snippets.join('\n\n'), context);
    return { context, calls, review, quiz, button, index };
}

test('strict exercise grading accepts complete structured responses including score zero', async () => {
    const { context } = await createExerciseGradingParserHarness();
    const tagged = context.parseExerciseGradingResponse(
        '<score>0</score>\n<solution>Full solution</solution>\n<errors>No errors</errors>\n<similar>Another problem</similar>',
        { strict: true }
    );
    assert.deepEqual(JSON.parse(JSON.stringify(tagged)), {
        score: 0,
        solution: 'Full solution',
        errors: 'No errors',
        similar_problem: 'Another problem'
    });

    const json = context.parseExerciseGradingResponse(
        '{"score":10,"solution":"S","errors":"E","similar_problem":"P"}',
        { strict: true }
    );
    assert.equal(json.score, 10);
});

test('strict exercise grading rejects invalid scores, missing sections, and prose', async () => {
    const { context } = await createExerciseGradingParserHarness();
    const complete = score => `<score>${score}</score><solution>S</solution><errors>E</errors><similar>P</similar>`;
    const invalidResponses = [
        '<solution>S</solution><errors>E</errors><similar>P</similar>',
        complete('NaN'),
        complete('4.5'),
        complete('-1'),
        complete('11'),
        '<score>5</score><errors>E</errors><similar>P</similar>',
        '<score>5</score><solution>S</solution><similar>P</similar>',
        '<score>5</score><solution>S</solution><errors>E</errors>',
        '<score>5</score><solution> </solution><errors>E</errors><similar>P</similar>',
        '{"score":5,"solution":"S","errors":"E","similar_problem":"P"',
        '{"score":5,"solution":"S","errors":"E","similar_problem":"P",}',
        "{'score':5,'solution':'S','errors':'E','similar_problem':'P'}",
        'null',
        '[]',
        '{"score":1e999,"solution":"S","errors":"E","similar_problem":"P"}',
        '{"score":4.5,"solution":"S","errors":"E","similar_problem":"P"}',
        '{"score":"NaN","solution":"S","errors":"E","similar_problem":"P"}',
        'Unable to grade this answer'
    ];

    for (const response of invalidResponses) {
        assert.throws(
            () => context.parseExerciseGradingResponse(response, { strict: true }),
            error => error.code === 'EXERCISE_GRADING_FORMAT_INVALID',
            response
        );
    }
});

test('legacy exercise grading keeps permissive parsing when Codex is disabled', async () => {
    const { context } = await createExerciseGradingParserHarness();
    const grading = context.parseExerciseGradingResponse('Unable to grade this answer', { strict: false });
    assert.equal(grading.score, 5);
    assert.equal(grading.solution, 'Unable to grade this answer');
});

test('all exercise grading commit callers enable strict parsing only for Codex', async () => {
    const { index } = await createExerciseGradingParserHarness();
    const guardedCalls = index.match(/parseExerciseGradingResponse\(result,\s*\{\s*strict:\s*!!\(appData\.settings && appData\.settings\.codexEnabled\)\s*\}\)/g) || [];
    assert.equal(guardedCalls.length, 3);

    const gradeAllSource = sourceBetween(
        index,
        'async function gradeAllExQuestions(',
        'async function exportExTaskAsPDF('
    );
    assert.match(gradeAllSource, /confirm\(i18n\('confirm_grade_all'\)\)/);
    assert.doesNotMatch(gradeAllSource, /confirm\(i18n\('confirm_delete'\)\)/);
    assert.equal((index.match(/confirm_grade_all:/g) || []).length, 3);
});

test('grade-all does not persist or mark done after an invalid Codex response', async () => {
    const { context, calls, question } = await createGradeAllHarness('Unable to grade this answer');
    await context.gradeAllExQuestions('folder', 'task');

    assert.equal(question.status, 'pending');
    assert.equal(question.score, null);
    assert.equal(calls.pageSaves, 0);
    assert.equal(calls.wrongUpserts, 0);
    assert.equal(calls.metadataSaves, 0);
    assert.equal(calls.failedCommits, 1);
});

test('grade-all commits a valid Codex score of zero', async () => {
    const response = '<score>0</score><solution>S</solution><errors>E</errors><similar>P</similar>';
    const { context, calls, question } = await createGradeAllHarness(response);
    await context.gradeAllExQuestions('folder', 'task');

    assert.equal(question.status, 'done');
    assert.equal(question.score, 0);
    assert.equal(calls.pageSaves, 1);
    assert.equal(calls.wrongUpserts, 1);
    assert.equal(calls.metadataSaves, 1);
});

test('single-question completion does not mark done after an invalid Codex response', async () => {
    const { context, calls, expectedState, question } =
        await createSingleQuestionGradingHarness('<score>5</score><solution>S</solution>');
    await context.exCompleteQuestionNow(expectedState, 'completion-token');

    assert.equal(question.status, 'pending');
    assert.equal(question.score, null);
    assert.equal(calls.wrongUpserts, 0);
    assert.equal(calls.metadataSaves, 0);
    assert.equal(calls.failedCommits, 1);
});

test('strict Notebook Review grading accepts its complete JSON contract including score zero', async () => {
    const response = JSON.stringify({
        score: 0,
        per_question: [{ q: ' 1 ', correct: false, comment: ' Missing the final step. ' }],
        solutions: ' Full derivation. '
    });
    const { context } = await createNotebookReviewGradingHarness(response);
    const grading = context.parseNotebookReviewGradingResponse(response, { strict: true });
    assert.deepEqual(JSON.parse(JSON.stringify(grading)), {
        score: 0,
        per_question: [{ q: '1', correct: false, comment: 'Missing the final step.' }],
        solutions: 'Full derivation.'
    });
});

test('strict Notebook Review grading rejects malformed JSON and incomplete fields', async () => {
    const valid = {
        score: 5,
        per_question: [{ q: '1', correct: true, comment: 'Correct.' }],
        solutions: 'Solution.'
    };
    const invalidResponses = [
        'Unable to grade this answer',
        '8/10',
        "{'score':5,'per_question':[],'solutions':'S'}",
        '{"score":5,"per_question":[],"solutions":"S",}',
        'null',
        '[]',
        JSON.stringify({ ...valid, score: '5' }),
        JSON.stringify({ ...valid, score: null }),
        JSON.stringify({ ...valid, score: -1 }),
        JSON.stringify({ ...valid, score: 11 }),
        '{"score":1e999,"per_question":[{"q":"1","correct":true,"comment":"C"}],"solutions":"S"}',
        JSON.stringify({ per_question: valid.per_question, solutions: valid.solutions }),
        JSON.stringify({ ...valid, per_question: [] }),
        JSON.stringify({ ...valid, per_question: 'not an array' }),
        JSON.stringify({ ...valid, per_question: [{ q: '', correct: true, comment: 'C' }] }),
        JSON.stringify({ ...valid, per_question: [{ q: '1', correct: 'true', comment: 'C' }] }),
        JSON.stringify({ ...valid, per_question: [{ q: '1', correct: true, comment: '' }] }),
        JSON.stringify({ score: 5, per_question: valid.per_question }),
        JSON.stringify({ ...valid, solutions: ' ' })
    ];
    const { context } = await createNotebookReviewGradingHarness(JSON.stringify(valid));

    for (const response of invalidResponses) {
        assert.throws(
            () => context.parseNotebookReviewGradingResponse(response, { strict: true }),
            error => error.code === 'NOTEBOOK_REVIEW_GRADING_FORMAT_INVALID',
            response
        );
    }
});

test('invalid Codex Notebook Review grading saves no grade and does not advance review', async () => {
    const { context, calls, review, quiz, button } =
        await createNotebookReviewGradingHarness('Unable to grade this answer');
    await context.nbCompleteQuizFs();

    assert.equal(calls.draftSaves, 1, 'the pre-request answer draft remains allowed');
    assert.equal(quiz.score, null);
    assert.equal(quiz.completedAt, null);
    assert.equal(quiz.aiComment, undefined);
    assert.deepEqual(
        { stage: review.stage, extra: review.extra, status: review.status },
        { stage: 0, extra: 0, status: 'pending' }
    );
    assert.equal(calls.touches, 0);
    assert.equal(calls.saves, 0);
    assert.equal(calls.syncs, 0);
    assert.equal(calls.shows, 0);
    assert.equal(calls.advances, 0);
    assert.equal(button.disabled, false);
    assert.equal(button.textContent, 'done');
    assert.match(calls.toasts.at(-1), /^grading_failed:/);
});

test('valid Codex Notebook Review grading commits score zero and advances once', async () => {
    const response = JSON.stringify({
        score: 0,
        per_question: [{ q: '1', correct: false, comment: 'Incorrect sign.' }],
        solutions: 'x = 2.'
    });
    const { context, calls, quiz } = await createNotebookReviewGradingHarness(response);
    await context.nbCompleteQuizFs();

    assert.equal(quiz.score, 0);
    assert.ok(quiz.completedAt);
    assert.match(quiz.aiComment, /Incorrect sign/);
    assert.equal(calls.touches, 1);
    assert.equal(calls.saves, 1);
    assert.equal(calls.syncs, 1);
    assert.equal(calls.shows, 1);
    assert.equal(calls.advances, 1);
});

test('legacy Notebook Review grading retains the default-five prose fallback', async () => {
    const { context, calls, quiz } = await createNotebookReviewGradingHarness(
        'Unable to grade this answer',
        { codexEnabled: false }
    );
    const grading = context.parseNotebookReviewGradingResponse(
        'Unable to grade this answer',
        { strict: false }
    );
    assert.equal(grading.score, 5);
    assert.deepEqual(JSON.parse(JSON.stringify(grading.per_question)), []);
    assert.equal(grading.solutions, 'Unable to grade this answer');

    await context.nbCompleteQuizFs();
    assert.equal(quiz.score, 5);
    assert.ok(quiz.completedAt);
    assert.equal(calls.saves, 1);
    assert.equal(calls.advances, 1);
});

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

test('Codex outline preflight skips hard limits and starts with at most 48-page chunks', async () => {
    const { context } = await createRoutingHarness();
    const codex = { codexEnabled: true };
    const legacy = { codexEnabled: false };
    const maxBytes = 64 * 1024 * 1024;

    assert.equal(context.outlinePdfChunkMaxPages(codex), 48);
    assert.equal(context.outlinePdfChunkMaxPages(legacy), 200);
    assert.equal(context.shouldSkipWholeOutlinePdf(codex, 49, 1), true);
    assert.equal(context.shouldSkipWholeOutlinePdf(codex, 48, maxBytes + 1), true);
    assert.equal(context.shouldSkipWholeOutlinePdf(codex, 48, maxBytes), false);
    assert.equal(context.shouldSkipWholeOutlinePdf(legacy, 500, maxBytes + 1), false);

    const codexRanges = JSON.parse(JSON.stringify(context.buildOutlinePageRanges(125, 48, [])));
    assert.deepEqual(codexRanges, [
        { startPage: 1, endPage: 48 },
        { startPage: 49, endPage: 96 },
        { startPage: 97, endPage: 125 }
    ]);
    assert.ok(codexRanges.every(range => range.endPage - range.startPage + 1 <= 48));
    const legacyRanges = JSON.parse(JSON.stringify(context.buildOutlinePageRanges(401, 200, [])));
    assert.deepEqual(legacyRanges, [
        { startPage: 1, endPage: 200 },
        { startPage: 201, endPage: 400 },
        { startPage: 401, endPage: 401 }
    ]);

    const index = await readFile(new URL('../app/src/main/assets/www/index.html', import.meta.url), 'utf8');
    assert.match(index, /draft\.wholeTokenLimited \|\| skipWholeOutlinePdf/);
    assert.match(index, /totalPages, outlineChunkMaxPages, pdfInfo\.outlinePages/);
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
