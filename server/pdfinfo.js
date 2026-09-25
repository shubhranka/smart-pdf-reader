import fs from 'node:fs/promises';

/**
 * Read page count and embedded title without spinning up a worker thread.
 * Returns safe fallbacks rather than throwing — a PDF we can't introspect
 * is still a PDF the browser can render.
 */
export async function inspectPdf(filePath, fallbackTitle) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  let task;
  try {
    const data = new Uint8Array(await fs.readFile(filePath));
    task = getDocument({ data, useWorkerFetch: false, isEvalSupported: false, useSystemFonts: false });
    const doc = await task.promise;
    const { info } = await doc.getMetadata().catch(() => ({ info: {} }));
    const embedded = typeof info?.Title === 'string' ? info.Title.trim() : '';
    return { pages: doc.numPages, title: embedded || fallbackTitle };
  } catch {
    return { pages: 0, title: fallbackTitle };
  } finally {
    await task?.destroy().catch(() => {});
  }
}
