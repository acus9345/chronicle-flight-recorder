/**
 * Chronicle Single-File Canvas Bundler (`scripts/bundle-canvas.js`)
 * Inlines `src/ui/styles/utilitarian-dark.css`, `src/ui/js/sample-traces.js`,
 * and `src/ui/js/app.js` into `src/ui/index.html` to produce a standalone
 * interactive preview file while preserving the modular multi-file repository.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const uiDir = path.join(repoRoot, 'src/ui');

const htmlTemplate = fs.readFileSync(path.join(uiDir, 'index.html'), 'utf8');
const cssContent = fs.readFileSync(path.join(uiDir, 'styles/utilitarian-dark.css'), 'utf8');
const tracesJs = fs.readFileSync(path.join(uiDir, 'js/sample-traces.js'), 'utf8');
const appJs = fs.readFileSync(path.join(uiDir, 'js/app.js'), 'utf8');

// Use function replacers so '$' patterns inside JS/CSS strings are never interpreted by String.replace
const bundledHtml = htmlTemplate
  .replace(
    '<link rel="stylesheet" href="./styles/utilitarian-dark.css" />',
    () => `<style>\n${cssContent}\n</style>`
  )
  .replace(
    '<script src="./js/sample-traces.js"></script>\n  <script src="./js/app.js"></script>',
    () => `<script>\n${tracesJs}\n\n${appJs}\n</script>`
  );

const outPath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(repoRoot, 'dist/chronicle_inspector.html');

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, bundledHtml, 'utf8');
console.log(`Bundled standalone Inspector UI to ${outPath} (${Buffer.byteLength(bundledHtml)} bytes)`);
