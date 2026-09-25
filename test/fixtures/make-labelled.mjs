/**
 * Writes labelled.pdf: six pages numbered the way a book is — i, ii, then 1–4 — with a
 * two-level outline. Hand-built so the test needs no PDF library.
 *
 *   node test/fixtures/make-labelled.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const PAGE_TEXT = ['Preface page', 'Contents page', 'Chapter one begins', 'Section one point one',
  'Section one point two', 'Chapter two begins'];

// Object numbers: 1 catalog, 2 pages, 3 font, 4 outlines, then per page (page, content),
// then outline items.
const objects = [];
const pageObj = (i) => 5 + i * 2;
const contentObj = (i) => 6 + i * 2;
const firstItem = 5 + PAGE_TEXT.length * 2;

const outline = [
  { title: 'Preface', page: 0, top: 792 },
  { title: 'Chapter 1. Beginnings', page: 2, top: 792, children: [
    { title: 'Section 1.1', page: 3, top: 792 },
    { title: 'Section 1.2', page: 4, top: 400 },
  ] },
  { title: 'Chapter 2. Endings', page: 5, top: 792 },
];

// Number every outline item in document order.
let next = firstItem;
const number = (items) => { for (const it of items) { it.obj = next++; number(it.children ?? []); } };
number(outline);
const count = (items) => items.reduce((n, it) => n + 1 + count(it.children ?? []), 0);

objects[1] = '<< /Type /Catalog /Pages 2 0 R /Outlines 4 0 R /PageMode /UseOutlines '
  + '/PageLabels << /Nums [0 << /S /r >> 2 << /S /D >>] >> >>';
objects[2] = `<< /Type /Pages /Kids [${PAGE_TEXT.map((_, i) => `${pageObj(i)} 0 R`).join(' ')}] /Count ${PAGE_TEXT.length} >>`;
objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
objects[4] = `<< /Type /Outlines /First ${outline[0].obj} 0 R /Last ${outline.at(-1).obj} 0 R /Count ${count(outline)} >>`;

PAGE_TEXT.forEach((text, i) => {
  const stream = `BT /F1 24 Tf 72 700 Td (${text}) Tj ET\nBT /F1 14 Tf 72 380 Td (Lower half of the page) Tj ET`;
  objects[pageObj(i)] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] `
    + `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentObj(i)} 0 R >>`;
  objects[contentObj(i)] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
});

const writeItems = (items, parent) => items.forEach((it, i) => {
  const kids = it.children ?? [];
  objects[it.obj] = `<< /Title (${it.title}) /Parent ${parent} 0 R`
    + (i > 0 ? ` /Prev ${items[i - 1].obj} 0 R` : '')
    + (i < items.length - 1 ? ` /Next ${items[i + 1].obj} 0 R` : '')
    + (kids.length ? ` /First ${kids[0].obj} 0 R /Last ${kids.at(-1).obj} 0 R /Count ${kids.length}` : '')
    + ` /Dest [${pageObj(it.page)} 0 R /XYZ 0 ${it.top} null] >>`;
  writeItems(kids, it.obj);
});
writeItems(outline, 4);

let out = '%PDF-1.4\n';
const offsets = [];
for (let n = 1; n < objects.length; n++) {
  offsets[n] = Buffer.byteLength(out);
  out += `${n} 0 obj\n${objects[n]}\nendobj\n`;
}
const xref = Buffer.byteLength(out);
out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
for (let n = 1; n < objects.length; n++) out += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

fs.writeFileSync(path.join(HERE, 'labelled.pdf'), out);
console.log(`wrote labelled.pdf (${PAGE_TEXT.length} pages, ${count(outline)} outline entries)`);
