# Independent repository setup

Canonical repository: https://github.com/none0enon/math-reader-boox-codex

The code is derived from the stable `none0enon/math-reader-boox` repository at `15a156b2a78aa6d591ea2b9f07d6edeb7f33f27a`, with the personal Codex gateway commits `fc34a1b` and `c05b43c`. Git history and existing notices are preserved. This repository is independent, not a pull request targeting the stable application.

## Current boundaries

- The repository is public, as requested by the owner. No GitHub Pages site is enabled here.
- Automated gateway/frontend tests and the unsigned APK build remain available.
- `APK_VERSION_CODE_BASE` is a non-secret repository variable. The initial value is `120000`; it is not evidence that a new APK may safely replace an installed stable APK.
- Official signing is skipped until this repository has its own `APK_SIGNING_CERT_SHA256` variable and the required signing environment/secrets. No keystore, password, ChatGPT login, Gemini key, R2 credentials, or gateway token is copied to GitHub.
- `Sign APK` retains the original workflow, but requires deliberate setup in this repository: the `apk-signing` environment, secrets `APK_SIGNING_KEYSTORE_BASE64` and `APK_SIGNING_PASSWORD`, and certificate variable `APK_SIGNING_CERT_SHA256`. Do not reuse or rotate the stable app's signing key as an incidental migration step.

## Before distributing the experimental application

The inherited Android application ID is still `com.mathreader.boox`. The user should choose whether this experiment is intended to replace the stable installation or run alongside it. For side-by-side use, change the application ID/display identity and the signing workflow's package validation together, then test installation and data isolation. Do not ask users to uninstall the stable application to resolve a signature/version conflict.

The PWA uses relative start/scope URLs, but localStorage and IndexedDB are shared by origin, not by repository URL path. Publishing both repositories under `https://none0enon.github.io/` does not by itself isolate their data. Before enabling the experimental PWA, use a separate origin or separately namespace its storage and test isolation. Do not publish it over the stable Pages site.

## Gateway and authentication

Follow [the private gateway guide](gateway/README.md). Its `.state/` directory and Node dependencies are excluded from Git. The gateway uses the pinned standalone Codex CLI and a separate ChatGPT login; no OpenAI API key is accepted. Authentication, private HTTPS access, real model behavior and BOOX use still require live acceptance testing.
