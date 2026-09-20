import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const namespace = require('../app/src/main/assets/www/storage-namespace.js');

class FakeStorage {
    constructor(entries = []) {
        this.values = new Map(entries.map(([key, value]) => [String(key), String(value)]));
    }

    get length() { return this.values.size; }
    key(index) { return Array.from(this.values.keys())[index] ?? null; }
    getItem(key) {
        key = String(key);
        return this.values.has(key) ? this.values.get(key) : null;
    }
    setItem(key, value) { this.values.set(String(key), String(value)); }
    removeItem(key) { this.values.delete(String(key)); }
    clear() { this.values.clear(); }
}

const appUrl = relative => new URL('../app/src/main/assets/www/' + relative, import.meta.url);
const docsUrl = relative => new URL('../docs/' + relative, import.meta.url);

test('independent Web Storage never reads or overwrites stable keys', () => {
    const stableValue = JSON.stringify({ stable: true });
    const physical = new FakeStorage([
        ['mathReader', stableValue],
        ['mathreader_lang', 'zh']
    ]);
    const storage = namespace.createNamespacedStorage(physical, namespace.STORAGE_PREFIX);

    assert.equal(storage.getItem('mathReader'), null);
    assert.equal(storage.getItem('mathreader_lang'), null);

    storage.setItem('mathReader', JSON.stringify({ independent: true }));
    storage.setItem('mathreader_lang', 'en');

    assert.equal(physical.getItem('mathReader'), stableValue);
    assert.equal(physical.getItem('mathreader_lang'), 'zh');
    assert.equal(storage.getItem('mathReader'), JSON.stringify({ independent: true }));
    assert.equal(storage.getItem('mathreader_lang'), 'en');
    assert.equal(storage.length, 2);
    assert.deepEqual([storage.key(0), storage.key(1)].sort(), ['mathReader', 'mathreader_lang']);
    assert.equal(storage.key(2), null);
});

test('removeItem and clear are restricted to the application namespace', () => {
    const otherApplication = 'some-other-app:v1:item';
    const physical = new FakeStorage([
        ['mathReader', 'stable'],
        [otherApplication, 'other'],
        [namespace.STORAGE_PREFIX + 'first', 'one'],
        [namespace.STORAGE_PREFIX + 'second', 'two']
    ]);
    const storage = namespace.createNamespacedStorage(physical, namespace.STORAGE_PREFIX);

    storage.removeItem('first');
    assert.equal(physical.getItem(namespace.STORAGE_PREFIX + 'first'), null);
    assert.equal(physical.getItem('mathReader'), 'stable');

    storage.clear();
    assert.equal(storage.length, 0);
    assert.equal(physical.getItem('mathReader'), 'stable');
    assert.equal(physical.getItem(otherApplication), 'other');
});

test('blocked browser storage fails closed instead of pretending to persist', async () => {
    const source = await readFile(appUrl('storage-namespace.js'), 'utf8');
    const context = vm.createContext({});
    vm.runInContext('globalThis.window = globalThis;', context);
    Object.defineProperty(context, 'localStorage', {
        configurable: true,
        get() { throw new Error('blocked'); }
    });
    Object.defineProperty(context, 'sessionStorage', {
        configurable: true,
        get() { throw new Error('blocked'); }
    });
    vm.runInContext(source, context);

    assert.throws(() => context.mrLocalStorage.setItem('key', 'value'), /localStorage is unavailable/);
    assert.throws(() => context.mrSessionStorage.getItem('key'), /sessionStorage is unavailable/);
});

test('IndexedDB and Cache Storage names have distinct application prefixes', () => {
    assert.equal(
        namespace.indexedDbName('mathReaderFiles'),
        'math-reader-boox-codex:v1:indexeddb:mathReaderFiles'
    );
    assert.equal(
        namespace.cacheName('shell-v2'),
        'math-reader-boox-codex:v1:cache:shell-v2'
    );
    assert.notEqual(namespace.indexedDbName('mathReaderFiles'), 'mathReaderFiles');
});

test('service worker activation preserves every unrelated application cache', async () => {
    const source = await readFile(appUrl('sw.js'), 'utf8');
    const listeners = {};
    const deleted = [];
    let claimed = false;
    const context = vm.createContext({
        self: {
            skipWaiting() {},
            clients: { claim: async () => { claimed = true; } },
            addEventListener(type, listener) { listeners[type] = listener; }
        },
        caches: {
            keys: async () => [
                'stable-math-reader-cache',
                'unrelated-app-cache',
                namespace.cacheName('old-shell')
            ],
            delete: async key => { deleted.push(key); return true; }
        },
        Promise
    });
    vm.runInContext(source, context);
    let activation;
    listeners.activate({ waitUntil(promise) { activation = promise; } });
    await activation;

    assert.deepEqual(deleted, [namespace.cacheName('old-shell')]);
    assert.equal(claimed, true);
});

test('application source loads the namespace first and has no direct stable storage access', async () => {
    const index = await readFile(appUrl('index.html'), 'utf8');
    assert.ok(index.indexOf('src="storage-namespace.js"') < index.indexOf('src="recording-storage.js"'));
    assert.doesNotMatch(index, /\blocalStorage\s*\.(?:getItem|setItem|removeItem|clear|key)\s*\(/);
    assert.doesNotMatch(index, /\bsessionStorage\s*\.(?:getItem|setItem|removeItem|clear|key)\s*\(/);
    assert.doesNotMatch(index, /indexedDB\.open\(\s*['"]mathReaderFiles['"]/);
    assert.match(index, /indexedDB\.open\(indexedDbName\(['"]mathReaderFiles['"]\),\s*1\)/);
});

test('all display names use exactly the user-specified project name', async () => {
    const [index, manifestText] = await Promise.all([
        readFile(appUrl('index.html'), 'utf8'),
        readFile(appUrl('manifest.json'), 'utf8')
    ]);
    const manifest = JSON.parse(manifestText);

    assert.doesNotMatch(index, /codex-experiment-badge|实验版|Codex Experiment|Expérience Codex/);
    assert.match(index, /<title data-i18n="app_title">math-reader-codex<\/title>/);
    assert.match(index, /name="apple-mobile-web-app-title" content="math-reader-codex"/);
    assert.deepEqual(Array.from(index.matchAll(/app_title:'([^']+)'/g), match => match[1]),
        ['math-reader-codex', 'math-reader-codex', 'math-reader-codex']);
    assert.equal(manifest.name, 'math-reader-codex');
    assert.equal(manifest.short_name, 'math-reader-codex');
    assert.equal(manifest.description, '专注数学阅读与笔记');
});

test('Android uses the specified name and original icon with an independent package', async () => {
    const [strings, colors, icon, gradle] = await Promise.all([
        readFile(new URL('../app/src/main/res/values/strings.xml', import.meta.url), 'utf8'),
        readFile(new URL('../app/src/main/res/values/colors.xml', import.meta.url), 'utf8'),
        readFile(new URL('../app/src/main/res/drawable/ic_launcher_foreground.xml', import.meta.url), 'utf8'),
        readFile(new URL('../app/build.gradle', import.meta.url), 'utf8')
    ]);
    assert.match(strings, /<string name="app_name">math-reader-codex<\/string>/);
    assert.match(colors, /<color name="ic_launcher_background">#FFFFFF<\/color>/);
    assert.match(icon, /android:strokeColor="#000000"/);
    assert.match(gradle, /applicationId "com\.mathreader\.boox\.codex"/);
});

test('Android and GitHub Pages copies of changed frontend assets are identical', async () => {
    for (const asset of ['index.html', 'manifest.json', 'sw.js', 'storage-namespace.js']) {
        const [app, docs] = await Promise.all([
            readFile(appUrl(asset)),
            readFile(docsUrl(asset))
        ]);
        assert.deepEqual(app, docs, asset + ' differs between app assets and docs');
    }
});
