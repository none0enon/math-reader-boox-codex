# Independent repository setup

Canonical repository: https://github.com/none0enon/math-reader-boox-codex

The code is derived from the stable `none0enon/math-reader-boox` repository at `15a156b2a78aa6d591ea2b9f07d6edeb7f33f27a`, with the personal Codex gateway commits `fc34a1b` and `c05b43c`. Git history and existing notices are preserved. This repository is independent, not a pull request targeting the stable application.

## Current boundaries

- The repository is public, as requested by the owner. Its independent Pages URL is `https://none0enon.github.io/math-reader-boox-codex/`; the `Deploy GitHub Pages` workflow tests and publishes only `docs/`, never the gateway or private state. Commit the APK web assets and their `docs/` mirror together: the deploy workflow fails closed on divergence. A bot-only mirror synchronization does not automatically trigger another Pages run; after fixing a mismatch, dispatch this workflow on `main`.
- Automated gateway/frontend tests and the unsigned APK build remain available.
- `APK_VERSION_CODE_BASE` is a non-secret repository variable with initial value `147000`. It controls monotonic updates within the new independent application, not replacement of the stable app.
- Independent signing is configured in this repository's `apk-signing` environment, restricted to `main`: secrets `APK_SIGNING_KEYSTORE_BASE64` and `APK_SIGNING_PASSWORD`, plus public certificate variable `APK_SIGNING_CERT_SHA256`. Signing credentials are encrypted Actions environment secrets, never committed. ChatGPT login, Gemini key, R2 credentials and gateway token stay off GitHub.
- `Sign APK` validates `com.mathreader.boox.codex` and signs using alias `math-reader-codex-release`. Its dedicated certificate SHA-256 is `D45BD67FEB2C0E4B4871F0EFC454F93B4BD3FCEF9197084882547FB5EC38DD7B`. The stable app's signing key was not read or reused. Keep an offline private backup of the new key/password to preserve future updates.

## Before distributing the experimental application

The owner selected side-by-side installation. The application ID is `com.mathreader.boox.codex`, launcher label is `Math Reader Codex`, and the dark-background/white-infinity icon distinguishes it from stable `com.mathreader.boox`. The Java namespace remains `com.mathreader.boox`; the manifest explicitly names its component classes. The merged AndroidX provider authority is `com.mathreader.boox.codex.androidx-startup`; no shared UID or legacy provider/deep-link authority collision was found. Android allocates independent app data by application ID. Local debug/release builds and packaged identity checks pass. Actual BOOX installation, launch, handwriting and uninstall/data-isolation acceptance remain required; never uninstall the stable app to resolve a signature/version conflict. Do not configure both apps to overwrite the same cloud-sync target.

The PWA uses relative start/scope URLs. Because browser storage is shared by origin rather than repository path, this experiment uses the dedicated `math-reader-boox-codex:v1:` namespace for Web Storage, IndexedDB and cache names. It never automatically reads or migrates unprefixed stable data. The service worker only deletes caches with the experiment's prefix. Unit tests and a disposable real Chrome context verify that stable settings, database records, and caches survive experiment initialization, saving and reloads. This is application-data separation, not a security boundary against malicious scripts sharing the same origin; use a separate domain for that stronger boundary. Do not publish over the stable Pages site.

## Gateway and authentication

Follow [the private gateway guide](gateway/README.md). Its `.state/` directory and Node dependencies are excluded from Git. The gateway uses the pinned standalone Codex CLI and a separate ChatGPT login; no OpenAI API key is accepted. On 2026-09-20, real ChatGPT authentication plus text/image/PDF/grading samples succeeded on the selected Mac, and a Tailscale Serve private HTTPS status request returned authenticated readiness. BOOX connectivity and Gemini audio still require real-device acceptance testing. No credentials or user-specific private network configuration are published in this repository.
