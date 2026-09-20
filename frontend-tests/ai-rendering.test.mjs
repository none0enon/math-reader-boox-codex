import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const index = await readFile(new URL('../app/src/main/assets/www/index.html', import.meta.url), 'utf8');
function between(start, end) {
    const from = index.indexOf(start), to = index.indexOf(end, from + start.length);
    assert.ok(from >= 0 && to > from, 'source markers must match');
    return index.slice(from, to);
}
const renderer = vm.createContext({ escapeHtml: text => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') });
vm.runInContext(between('function renderChatMarkdownLatex(', '// ==================== 聊天消息：操作按钮'), renderer);

test('AI markdown always escapes raw HTML, even if an old caller passes false', () => {
    for (const payload of ['<img src=x onerror="alert(1)">', '<svg onload="alert(1)">', '<iframe srcdoc="<script>alert(1)</script>">', '<a href="javascript:alert(1)">click</a>']) {
        const html = renderer.renderChatMarkdownLatex(payload, false);
        assert.doesNotMatch(html, /<(?:img|svg|iframe|script|a)\b/i);
        assert.match(html, /&lt;/);
    }
});

test('safe markdown preserves headings, emphasis, lists and escaped math', () => {
    const html = renderer.renderChatMarkdownLatex('# Title\n**bold**\n- item\n$a<b$\n\\[x>0\\]');
    assert.match(html, /<h1>Title<\/h1>/);
    assert.match(html, /<strong>bold<\/strong>/);
    assert.match(html, /<li>item<\/li>/);
    assert.match(html, /\$a&lt;b\$/);
    assert.match(html, /\$\$x&gt;0\$\$/);
    assert.doesNotThrow(() => renderer.renderChatMarkdownLatex('%%LATEXINLINE999%% %%LATEXBLOCK999%%'));
});

test('formulas cannot smuggle HTML and lecture uses the same safe renderer', () => {
    const html = renderer.renderChatMarkdownLatex('$<img src=x onerror=alert(1)>$');
    assert.doesNotMatch(html, /<img/i);
    const lecture = between('async function displayLectureContent()', 'function renderLectureMath(');
    assert.match(lecture, /renderChatMarkdownLatex\(contentText\)/);
    assert.doesNotMatch(lecture, /let content = contentText/);
    assert.match(between('function renderLectureMath(', 'function autoWrapLatexFormulas('), /trust:\s*false/);
});

test('Codex lecture stops on missing PDF instead of generating ungrounded text', async () => {
    const chapter = { id: 'chapter', title: 'Test', status: 'pending', topics: [], startPage: 1, endPage: 1 };
    let calls = 0, saves = 0;
    const ctx = vm.createContext({
        appData: { settings: { codexEnabled: true }, books: [{ id: 'book', title: 'Book' }], lectures: { book: { chapters: [chapter] } } },
        currentLecture: null, activeLectureGenerationCount: 0, r2SyncInProgress: false, r2PendingSyncQueue: [],
        i18n: key => key, saveData() {}, showToast() {}, renderNotesPage() {},
        console: { error() {} }, loadBookPdfBytes: async () => { throw new Error('missing PDF'); },
        callAI: async () => { calls++; return 'made-up chapter'; },
        saveLectureContent: async () => { saves++; },
    });
    vm.runInContext(between('async function generateChapterContent(', '// 讲义阅读器状态'), ctx);
    await ctx.generateChapterContent('book', 0);
    assert.equal(calls, 0);
    assert.equal(saves, 0);
    assert.equal(chapter.status, 'error');
    assert.equal(ctx.activeLectureGenerationCount, 0);
});

test('Codex reader Q&A does not send a request when its PDF page cannot load', async () => {
    let calls = 0;
    const toasts = [];
    const ctx = vm.createContext({
        appData: { settings: { codexEnabled: true } }, readerChatDoc: { id: 'book', type: 'pdf' }, readerChatQuote: '',
        document: { getElementById: () => ({ value: 'Explain this page' }) },
        clearChatQuote() {}, loadReaderChatHistory: () => [], saveReaderChatHistory() {}, renderReaderChatHistory() {},
        loadBookPdfBytes: async () => { throw new Error('missing PDF'); },
        callReaderAI: async () => { calls++; }, showToast: t => toasts.push(t), i18n: key => key,
        console: { error() {} },
    });
    vm.runInContext(between('async function sendReaderChatMessage()', 'async function callAI('), ctx);
    await ctx.sendReaderChatMessage();
    assert.equal(calls, 0);
    assert.ok(toasts.some(t => t.includes('missing PDF')));
});
