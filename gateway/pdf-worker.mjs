import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import { createRequire } from 'node:module';
import { createCanvas, DOMMatrix, ImageData, Path2D } from '@napi-rs/canvas';

globalThis.DOMMatrix ||= DOMMatrix;
globalThis.ImageData ||= ImageData;
globalThis.Path2D ||= Path2D;

const require = createRequire(import.meta.url);
const pdfRoot = dirname(require.resolve('pdfjs-dist/package.json'));
const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
const [input, directory, maxPagesText] = process.argv.slice(2);
let document;
let loadingTask;

try {
  loadingTask = getDocument({
    data: new Uint8Array(await readFile(input)),
    isEvalSupported: false,
    useSystemFonts: false,
    standardFontDataUrl: join(pdfRoot, 'standard_fonts') + sep,
    cMapUrl: join(pdfRoot, 'cmaps') + sep,
    cMapPacked: true,
    wasmUrl: join(pdfRoot, 'wasm') + sep,
    stopAtErrors: true,
  });
  document = await loadingTask.promise;
  if (document.numPages > Number(maxPagesText)) {
    throw Object.assign(new Error(`PDF has ${document.numPages} pages; the context window accepts up to ${maxPagesText} rendered pages per request. Split the PDF into smaller ranges.`), {
      code: 'context_length_exceeded', statusCode: 413,
    });
  }
  const textParts = [
    `Attached PDF: ${document.numPages} pages. Every page is included below as an image, in ascending page order.`,
    'Text extraction is supplemental and may not preserve mathematical notation; use the page images for formulas and diagrams.',
  ];
  const images = [];
  let totalCharacters = 0;
  for (let number = 1; number <= document.numPages; number++) {
    const page = await document.getPage(number);
    const content = await page.getTextContent();
    const text = content.items.map(item => (item.str || '') + (item.hasEOL ? '\n' : ' ')).join('');
    totalCharacters += text.length;
    if (totalCharacters > 400_000) {
      throw Object.assign(new Error('PDF text exceeds the context window; split it into smaller page ranges.'), {
        code: 'context_length_exceeded', statusCode: 413,
      });
    }
    textParts.push(`--- Attachment page ${number} ---\n${text || '[Image-only page; see the corresponding image.]'}`);
    const normal = page.getViewport({ scale: 1 });
    const scale = Math.min(2.5, 1800 / Math.max(normal.width, normal.height));
    const viewport = page.getViewport({ scale });
    const canvas = createCanvas(Math.max(1, Math.ceil(viewport.width)), Math.max(1, Math.ceil(viewport.height)));
    await page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport }).promise;
    const path = join(directory, `page-${String(number).padStart(4, '0')}.png`);
    await writeFile(path, canvas.toBuffer('image/png'), { mode: 0o600, flag: 'wx' });
    images.push({ path, page: number });
    page.cleanup();
  }
  await loadingTask.destroy();
  document = null;
  process.send({ text: textParts.join('\n\n'), images, pageCount: images.length }, () => process.disconnect());
} catch (error) {
  await loadingTask?.destroy().catch(() => {});
  process.send({ error: {
    code: error.code || (error.name === 'PasswordException' ? 'pdf_password_required' : 'invalid_pdf'),
    message: error.name === 'PasswordException' ? 'Unlock this PDF before sending it to Codex.' : String(error.message || 'PDF could not be processed.'),
    statusCode: error.statusCode || 422,
  } }, () => process.disconnect());
}
