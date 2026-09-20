import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { preparePdfAttachment, PDF_MAX_PAGES } from '../pdf.mjs';

async function inDirectory(run) {
  const directory = await mkdtemp(join(tmpdir(), 'math-reader-pdf-test-'));
  try { return await run(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

async function fixture({ pages = 2, scanned = false } = {}) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let number = 1; number <= pages; number++) {
    const page = pdf.addPage([400, 400]);
    if (scanned) {
      const canvas = createCanvas(400, 400);
      const context = canvas.getContext('2d');
      context.fillStyle = 'white'; context.fillRect(0, 0, 400, 400);
      context.fillStyle = 'black'; context.font = '32px sans-serif';
      context.fillText(`x + ${number} = 4`, 40, 90);
      const image = await pdf.embedPng(canvas.toBuffer('image/png'));
      page.drawImage(image, { x: 0, y: 0, width: 400, height: 400 });
    } else {
      page.drawText(`Exercise ${number}: x + ${number} = 4`, { x: 35, y: 330, size: 18, font });
      page.drawLine({ start: { x: 40, y: 80 }, end: { x: 320, y: 260 }, thickness: 3, color: rgb(0, 0, 0) });
    }
  }
  return { base64: Buffer.from(await pdf.save()).toString('base64'), name: '../../outside.pdf' };
}

test('PDF keeps every page, text, formula/diagram images and safe filenames', async () => {
  await inDirectory(async directory => {
    const result = await preparePdfAttachment(await fixture(), { directory });
    assert.equal(result.pageCount, 2);
    assert.deepEqual(result.images.map(item => item.page), [1, 2]);
    assert.match(result.text, /Exercise 1: x \+ 1 = 4/);
    assert.match(result.text, /Exercise 2: x \+ 2 = 4/);
    assert.deepEqual((await readdir(directory)).sort(), ['page-0001.png', 'page-0002.png', 'source.pdf']);
    for (const image of result.images) {
      assert.equal((await stat(image.path)).mode & 0o777, 0o600);
      const bitmap = await loadImage(await readFile(image.path));
      assert.equal(bitmap.width, 1000);
      const canvas = createCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext('2d'); context.drawImage(bitmap, 0, 0);
      const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
      let dark = 0;
      for (let i = 0; i < pixels.length; i += 4) if (pixels[i] < 100 && pixels[i + 3] > 0) dark++;
      assert.ok(dark > 1000, 'Rendered page must contain visible text and diagram pixels.');
    }
  });
});

test('scanned PDF does not disappear when there is no text layer', async () => {
  await inDirectory(async directory => {
    const result = await preparePdfAttachment(await fixture({ scanned: true }), { directory });
    assert.equal(result.images.length, 2);
    assert.match(result.text, /Image-only page/);
    assert.ok((await stat(result.images[0].path)).size > 2000);
  });
});

test('oversize PDF returns recognizable context error before rendering any pages', async () => {
  await inDirectory(async directory => {
    await assert.rejects(preparePdfAttachment(await fixture({ pages: PDF_MAX_PAGES + 1 }), { directory }),
      error => error.code === 'context_length_exceeded' && error.statusCode === 413);
    assert.deepEqual(await readdir(directory), ['source.pdf']);
  });
});

test('invalid base64, non-PDF, and cancellation fail explicitly', async () => {
  await inDirectory(async directory => {
    await assert.rejects(preparePdfAttachment({ base64: '!!!!' }, { directory }), { code: 'invalid_pdf' });
    await assert.rejects(preparePdfAttachment({ base64: Buffer.from('Not a PDF').toString('base64') }, { directory }), { code: 'invalid_pdf' });
    const controller = new AbortController(); controller.abort();
    await assert.rejects(preparePdfAttachment(await fixture(), { directory, signal: controller.signal }), { name: 'AbortError' });
    assert.deepEqual(await readdir(directory), []);
  });
});

test('PDF worker timeout stops work instead of leaving a renderer running', async () => {
  await inDirectory(async directory => {
    await assert.rejects(preparePdfAttachment(await fixture(), { directory, timeoutMs: 1 }), { code: 'pdf_timeout' });
  });
});
