import { fork } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PDF_MAX_PAGES = 48;
export const PDF_MAX_BYTES = 64 * 1024 * 1024;

function failure(code, message, statusCode = 400) {
  return Object.assign(new Error(message), { code, statusCode });
}

// PDF parsing happens in a disposable child so malformed or very expensive PDFs
// cannot block HTTP cancellation or the gateway's event loop.
export async function preparePdfAttachment(attachment, { directory, signal, timeoutMs = 120_000 } = {}) {
  if (!attachment || typeof attachment.base64 !== 'string' || !directory) {
    throw failure('invalid_pdf', 'PDF attachment must contain base64 data.');
  }
  const encoded = attachment.base64;
  if (encoded.length > Math.ceil(PDF_MAX_BYTES / 3) * 4) {
    throw failure('context_length_exceeded', 'PDF exceeds the context window upload limit; split it into smaller page ranges.', 413);
  }
  if (!encoded.length || encoded.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    throw failure('invalid_pdf', 'PDF attachment contains invalid base64.');
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length > PDF_MAX_BYTES) {
    throw failure('context_length_exceeded', 'PDF exceeds the context window upload limit; split it into smaller page ranges.', 413);
  }
  if (bytes.toString('base64') !== encoded || !bytes.subarray(0, 1024).includes(Buffer.from('%PDF-'))) {
    throw failure('invalid_pdf', 'The attachment is not a PDF file.');
  }
  signal?.throwIfAborted();
  // The client filename is a label only, never a filesystem path.
  const input = join(directory, 'source.pdf');
  await writeFile(input, bytes, { mode: 0o600, flag: 'wx' });
  return new Promise((resolve, reject) => {
    const child = fork(fileURLToPath(new URL('./pdf-worker.mjs', import.meta.url)),
      [input, directory, String(PDF_MAX_PAGES)], {
        execArgv: ['--max-old-space-size=768'],
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        // PDF parsing has no reason to inherit credentials.
        env: { PATH: process.env.PATH || '', LANG: 'en_US.UTF-8' },
      });
    let settled = false;
    let result;
    child.stderr.on('data', chunk => {
      if (process.env.MATH_READER_PDF_DEBUG === '1') process.stderr.write(chunk);
    });
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve(result);
    };
    const abort = () => {
      child.kill('SIGKILL');
      finish(signal.reason || failure('cancelled', 'PDF processing cancelled.', 499));
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(failure('pdf_timeout', 'PDF processing timed out; try a smaller page range.', 408));
    }, timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.on('error', error => finish(failure('pdf_unavailable', `Could not start PDF renderer: ${error.message}`, 503)));
    child.on('message', message => {
      if (message?.error) {
        result = null;
        child.kill('SIGKILL');
        finish(failure(message.error.code || 'invalid_pdf', message.error.message, message.error.statusCode || 400));
      } else if (message?.pageCount && Array.isArray(message.images)) {
        result = message;
      }
    });
    child.on('exit', code => {
      if (code === 0 && result) finish();
      else finish(failure('pdf_failed', 'PDF renderer stopped before all pages were processed.', 422));
    });
  });
}
