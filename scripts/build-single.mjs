// Build a single self-contained HTML file: JS + CSS inlined, and all 8
// character sprites embedded as data URIs (so nothing can get separated from
// the HTML — the "impossible to break apart" distribution).
//
// Usage: npm run build && node scripts/build-single.mjs
// Output: dist/bash-arena-single.html

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const dist = 'dist';
let html = readFileSync(join(dist, 'index.html'), 'utf8');

// Inline the bundled JS.
html = html.replace(
  /<script type="module"[^>]*src="\.?\/?(assets\/[^"]+\.js)"[^>]*><\/script>/,
  (_, src) => {
    const js = readFileSync(join(dist, src), 'utf8')
      .replace(/\/\/# sourceMappingURL=.*$/m, '')
      .replace(/<\/script>/g, '<\\/script>');
    return `<script type="module">\n${js}\n</script>`;
  },
);

// Inline the CSS.
html = html.replace(
  /<link rel="stylesheet"[^>]*href="\.?\/?(assets\/[^"]+\.css)"[^>]*>/,
  (_, href) => `<style>\n${readFileSync(join(dist, href), 'utf8')}\n</style>`,
);

// Embed the character sprites as data URIs.
const charDir = 'public/chars';
const imgs = {};
for (const f of readdirSync(charDir)) {
  if (!f.endsWith('.webp')) continue;
  const key = f.replace('.webp', '');
  imgs[key] = 'data:image/webp;base64,' + readFileSync(join(charDir, f)).toString('base64');
}
html = html.replace(
  '<script type="module">',
  `<script>window.__CHAR_IMG=${JSON.stringify(imgs)};</script>\n<script type="module">`,
);

const out = join(dist, 'bash-arena-single.html');
writeFileSync(out, html);
console.log(`wrote ${out} (${(html.length / 1024).toFixed(0)} KB)`);
