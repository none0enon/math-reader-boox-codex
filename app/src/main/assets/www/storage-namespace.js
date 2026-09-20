(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) {
        root.MathReaderStorageNamespace = api;
        root.mrLocalStorage = api.mrLocalStorage;
        root.mrSessionStorage = api.mrSessionStorage;
        root.indexedDbName = api.indexedDbName;
        root.cacheName = api.cacheName;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
    'use strict';

    // This prefix is intentionally unrelated to the stable app's historical
    // keys. Never add fallback reads or automatic migration from unprefixed
    // storage: the Codex experiment must start with a clean local data set.
    const STORAGE_PREFIX = 'math-reader-boox-codex:v1:';
    const INDEXED_DB_PREFIX = STORAGE_PREFIX + 'indexeddb:';
    const CACHE_PREFIX = STORAGE_PREFIX + 'cache:';

    function unavailableStorage(name, unavailableCause) {
        const fail = function () {
            const error = new Error(name + ' is unavailable');
            if (unavailableCause !== undefined) error.cause = unavailableCause;
            throw error;
        };
        return {
            get length() { return fail(); },
            key: fail,
            getItem: fail,
            setItem: fail,
            removeItem: fail,
            clear: fail
        };
    }

    function browserStorage(name) {
        // Do not touch Node's experimental Web Storage getter when this UMD
        // module is loaded by unit tests. Real pages always have window === root.
        if (!root || root.window !== root) return unavailableStorage(name);
        try {
            const storage = root[name];
            if (storage && typeof storage.getItem === 'function') return storage;
        } catch (error) {
            return unavailableStorage(name, error);
        }
        return unavailableStorage(name);
    }

    function createNamespacedStorage(storage, prefix) {
        if (!storage || typeof storage.getItem !== 'function') {
            throw new TypeError('A Storage-compatible adapter is required');
        }
        const namespace = String(prefix || STORAGE_PREFIX);
        const physicalKey = key => namespace + String(key);

        function logicalKeys() {
            const keys = [];
            for (let index = 0; index < storage.length; index++) {
                const key = storage.key(index);
                if (typeof key === 'string' && key.startsWith(namespace)) {
                    keys.push(key.slice(namespace.length));
                }
            }
            return keys;
        }

        return Object.freeze({
            get length() { return logicalKeys().length; },
            key(index) {
                if (!Number.isInteger(index) || index < 0) return null;
                return logicalKeys()[index] ?? null;
            },
            getItem(key) { return storage.getItem(physicalKey(key)); },
            setItem(key, value) { storage.setItem(physicalKey(key), String(value)); },
            removeItem(key) { storage.removeItem(physicalKey(key)); },
            clear() {
                const keys = [];
                for (let index = 0; index < storage.length; index++) {
                    const key = storage.key(index);
                    if (typeof key === 'string' && key.startsWith(namespace)) keys.push(key);
                }
                keys.forEach(key => storage.removeItem(key));
            }
        });
    }

    function indexedDbName(name) {
        return INDEXED_DB_PREFIX + String(name);
    }

    function cacheName(name) {
        return CACHE_PREFIX + String(name);
    }

    return Object.freeze({
        STORAGE_PREFIX,
        INDEXED_DB_PREFIX,
        CACHE_PREFIX,
        createNamespacedStorage,
        mrLocalStorage: createNamespacedStorage(browserStorage('localStorage'), STORAGE_PREFIX),
        mrSessionStorage: createNamespacedStorage(browserStorage('sessionStorage'), STORAGE_PREFIX),
        indexedDbName,
        cacheName
    });
});
