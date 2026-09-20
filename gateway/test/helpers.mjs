import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function withTemporaryDirectory(prefix, run) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export function temporaryConfig(directory, overrides = {}) {
  const stateDirectory = join(directory, 'state');
  return {
    gatewayDirectory: directory,
    stateDirectory,
    codexHome: join(stateDirectory, 'codex-home'),
    isolatedHome: join(stateDirectory, 'home'),
    workspaceDirectory: join(stateDirectory, 'workspace'),
    temporaryDirectory: join(stateDirectory, 'tmp'),
    tokenFile: join(stateDirectory, 'gateway-token'),
    codexBin: 'codex-test',
    host: '127.0.0.1',
    port: 0,
    requestTimeoutMs: 1_000,
    maxQueueDepth: 2,
    maxBodyBytes: 1024 * 1024,
    allowedOrigins: new Set(['https://allowed.example']),
    tlsCertificateFile: null,
    tlsKeyFile: null,
    allowInsecureRemote: false,
    ...overrides,
  };
}

export async function eventually(predicate, message = 'condition was not met') {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(message);
}
