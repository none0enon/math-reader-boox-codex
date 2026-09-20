# Independent repository setup

Canonical repository: https://github.com/none0enon/math-reader-boox-codex

The code is derived from the stable `none0enon/math-reader-boox` repository at `15a156b2a78aa6d591ea2b9f07d6edeb7f33f27a`, with the personal Codex gateway commits `fc34a1b` and `c05b43c`. Git history and existing notices are preserved. This repository is independent, not a pull request targeting the stable application.

## Current boundaries

- The repository is public, as requested by the owner. Its independent Pages URL is `https://none0enon.github.io/math-reader-boox-codex/`; the `Deploy GitHub Pages` workflow tests and publishes only `docs/`, never the gateway or private state. Commit the APK web assets and their `docs/` mirror together: the deploy workflow fails closed on divergence. A bot-only mirror synchronization does not automatically trigger another Pages run; after fixing a mismatch, dispatch this workflow on `main`.
- Automated gateway/frontend tests and the unsigned APK build remain available.
- `APK_VERSION_CODE_BASE` is a non-secret repository variable. The initial value is `147000`, above the prior test APK's `146901` because the new repository's workflow counter starts again. This is not evidence that a new APK may safely replace an installed stable APK; signing and installation identity must be chosen first.
- Official signing is skipped until this repository has its own `APK_SIGNING_CERT_SHA256` variable and the required signing environment/secrets. No keystore, password, ChatGPT login, Gemini key, R2 credentials, or gateway token is copied to GitHub.
- `Sign APK` retains the original workflow, but requires deliberate setup in this repository: the `apk-signing` environment, secrets `APK_SIGNING_KEYSTORE_BASE64` and `APK_SIGNING_PASSWORD`, and certificate variable `APK_SIGNING_CERT_SHA256`. Do not reuse or rotate the stable app's signing key as an incidental migration step.

## Before distributing the experimental application

The inherited Android application ID is still `com.mathreader.boox`. The user should choose whether this experiment is intended to replace the stable installation or run alongside it. For side-by-side use, change the application ID/display identity and the signing workflow's package validation together, then test installation and data isolation. Do not ask users to uninstall the stable application to resolve a signature/version conflict.

The PWA uses relative start/scope URLs. Because browser storage is shared by origin rather than repository path, this experiment uses the dedicated `math-reader-boox-codex:v1:` namespace for Web Storage, IndexedDB and cache names. It never automatically reads or migrates unprefixed stable data. The service worker only deletes caches with the experiment's prefix. Unit tests and a disposable real Chrome context verify that stable settings, database records, and caches survive experiment initialization, saving and reloads. This is application-data separation, not a security boundary against malicious scripts sharing the same origin; use a separate domain for that stronger boundary. Do not publish over the stable Pages site.

## Gateway and authentication

Follow [the private gateway guide](gateway/README.md). Its `.state/` directory and Node dependencies are excluded from Git. The gateway uses the pinned standalone Codex CLI and a separate ChatGPT login; no OpenAI API key is accepted. On 2026-09-20, real ChatGPT authentication plus text/image/PDF/grading samples succeeded on the selected Mac, and a Tailscale Serve private HTTPS status request returned authenticated readiness. BOOX connectivity and Gemini audio still require real-device acceptance testing. No credentials or user-specific private network configuration are published in this repository.
