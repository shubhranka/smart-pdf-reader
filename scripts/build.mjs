// Assembles dist/: what the server needs to run, and none of your library. The code is
// copied as is (there is still no build step), so this is a package for deploying.
// Copying dist/ to the server can never carry pdfs/, data/ or .env over its own copies.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'dist');
const INCLUDE = ['server', 'public', 'deploy', 'package.json', 'package-lock.json', '.env.example'];

// Starting the app from dist/ makes a library inside it. Don't delete that with the old build.
const kept = ['pdfs', 'data', '.env', 'models'].filter((name) => fs.existsSync(path.join(OUT, name)));
if (kept.length) {
  console.error(`dist/ holds ${kept.join(', ')}, which may be real work. Move it out, then build again.`);
  process.exit(1);
}

// Nothing compiles this code, so without this a syntax error would first show up on the server.
const sources = ['server', 'public'].flatMap((dir) =>
  fs.readdirSync(path.join(ROOT, dir), { recursive: true })
    .filter((file) => /\.m?js$/.test(file))
    .map((file) => path.join(dir, file)));
const broken = sources.filter((file) =>
  spawnSync(process.execPath, ['--check', file], { cwd: ROOT, stdio: 'inherit' }).status !== 0);
if (broken.length) {
  console.error(`Build failed: ${broken.join(', ')} did not parse.`);
  process.exit(1);
}

fs.rmSync(OUT, { recursive: true, force: true });
for (const name of INCLUDE) {
  fs.cpSync(path.join(ROOT, name), path.join(OUT, name), {
    recursive: true,
    filter: (src) => path.basename(src) !== '.DS_Store',
  });
}
console.log(`Checked ${sources.length} files and built dist/. On the server, run: npm ci --omit=dev`);
