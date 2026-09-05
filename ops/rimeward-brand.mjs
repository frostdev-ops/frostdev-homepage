// Regenerates the Rimeward brand assets from one description — the mark
// (assets/rimeward-mark.svg), the login lockup (assets/rimeward-lockup.svg)
// and the app icon source (desktop/icon-1024.png, then `cargo tauri icon`).
// Direction A, "Rime crystal": the frostdev half-flake grown to six feathered
// arms inside a hexagonal ward ring; the wordmark in the FROSTDEV cut.
//   node ops/rimeward-brand.mjs
import fs from 'node:fs';
import sharp from 'sharp';

const CYAN = '#17c8f4', CYAN2 = '#6fdcff', NAVY = '#164a74', NAVY2 = '#0b2a4a', MUTED = '#5c7189';

// ---- the crystal, centred on 0,0 in a 320 box
function crystal() {
  const arm = `<path d="M0,0 L0,-118" stroke="${CYAN}" stroke-width="14"/>
    <path d="M0,-44 L-30,-72 M0,-44 L30,-72 M0,-82 L-20,-102 M0,-82 L20,-102 M0,-20 L-14,-33 M0,-20 L14,-33" stroke="${CYAN}" stroke-width="8" stroke-linejoin="bevel"/>
    <path d="M0,-110 L-6,-118 L0,-126 L6,-118 Z" fill="${CYAN2}"/>`;
  const arms = [0, 60, 120, 180, 240, 300].map((a) => `<g transform="rotate(${a})">${arm}</g>`).join('\n');
  const hex = [0, 60, 120, 180, 240, 300].map((a) => { const t = ((a - 90) * Math.PI) / 180; return `${(150 * Math.cos(t)).toFixed(1)},${(150 * Math.sin(t)).toFixed(1)}`; }).join(' ');
  return `<polygon points="${hex}" fill="none" stroke="${NAVY}" stroke-width="8" stroke-linejoin="bevel"/>
  <circle r="10" fill="${NAVY2}"/>
  ${arms}
  <circle r="7" fill="${CYAN2}"/>`;
}

// ---- the wordmark: centre-line strokes with bevel joins, the FROSTDEV chamfer
const L = {
  R: { w: 80, p: ['8,0 8,100', '8,8 56,8 72,24 72,40 56,56 8,56', '42,56 72,100'] },
  I: { w: 24, p: ['12,0 12,100'] },
  M: { w: 88, p: ['8,100 8,0 44,52 80,0 80,100'] },
  E: { w: 72, p: ['70,8 8,8 8,92 70,92', '8,50 54,50'] },
  W: { w: 96, p: ['8,0 22,100 48,36 74,100 88,0'] },
  A: { w: 84, p: ['8,100 42,0 76,100', '22,66 62,66'] },
  D: { w: 80, p: ['8,0 8,100', '8,8 48,8 72,32 72,68 48,92 8,92'] },
};
const PAL = { R: CYAN, W: CYAN };
// The bevel highlight is the same stroke, thin and nudged up-left, masked to
// the letter so it never pokes past a stroke's end.
function wordmark(text, id = 'wm') {
  let x = 8, main = '', hi = '', mask = '';
  for (const ch of text) {
    const g = L[ch];
    const col = PAL[ch] ?? NAVY;
    for (const pts of g.p) {
      main += `<polyline points="${pts}" transform="translate(${x} 0)" fill="none" stroke="${col}" stroke-width="16" stroke-linejoin="bevel"/>\n`;
      mask += `<polyline points="${pts}" transform="translate(${x} 0)" fill="none" stroke="#fff" stroke-width="16" stroke-linejoin="bevel"/>\n`;
      hi += `<polyline points="${pts}" transform="translate(${x - 3} -3)" fill="none" stroke="${col === NAVY ? NAVY2 : CYAN2}" stroke-width="4" stroke-linejoin="bevel" opacity="0.9"/>\n`;
    }
    x += g.w + 20;
  }
  const body = `<mask id="${id}-m" maskUnits="userSpaceOnUse" x="-20" y="-20" width="${x + 40}" height="140">${mask}</mask>\n${main}<g mask="url(#${id}-m)">${hi}</g>\n`;
  return { body, w: x + 8 };
}

const mark = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 320" role="img" aria-label="Rimeward">
<g transform="translate(160 160)">
  ${crystal()}
</g>
</svg>
`;
fs.writeFileSync('assets/rimeward-mark.svg', mark);

const wm = wordmark('RIMEWARD');
// Lockup: mark 240 tall at the left, the wordmark scaled to 150 cap height beside it, "by frostdev" under it.
const S = 1.5;
const W = 300 + wm.w * S + 20;
const lockup = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${Math.round(W)} 300" role="img" aria-label="Rimeward by frostdev">
<g transform="translate(150 150) scale(0.9)">
  ${crystal()}
</g>
<g transform="translate(300 60) scale(${S})">
${wm.body}</g>
<text x="${312}" y="268" fill="${MUTED}" font-family="ui-sans-serif, system-ui, sans-serif" font-size="30" font-weight="600" letter-spacing="10">BY FROSTDEV</text>
</svg>
`;
fs.writeFileSync('assets/rimeward-lockup.svg', lockup);

// App icon: the macOS rounded square (Apple's 22.4% radius, ~80% of the canvas), the crystal at 72% of it.
const icon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
<defs>
  <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#123a5c"/><stop offset="0.55" stop-color="#0d1b2e"/><stop offset="1" stop-color="#06101f"/>
  </linearGradient>
  <linearGradient id="h" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#eaf6f9" stop-opacity="0.14"/><stop offset="0.12" stop-color="#eaf6f9" stop-opacity="0"/>
  </linearGradient>
</defs>
<rect x="100" y="100" width="824" height="824" rx="185" fill="url(#g)"/>
<rect x="100" y="100" width="824" height="824" rx="185" fill="url(#h)"/>
<g transform="translate(512 512) scale(1.85)">
  ${crystal()}
</g>
</svg>`;
await sharp(Buffer.from(icon)).png().toFile('desktop/icon-1024.png');
// The built-in favicon / apple-touch / 512 icons the /brand route serves when an instance drops none of its own.
for (const [name, size] of [['favicon', 64], ['apple-touch-icon', 180], ['icon-512', 512]])
  await sharp(Buffer.from(icon)).resize(size, size).png().toFile(`assets/rimeward-${name}.png`);
console.log(`wrote assets/rimeward-mark.svg, assets/rimeward-lockup.svg (${Math.round(W)}x300), assets/rimeward-{favicon,apple-touch-icon,icon-512}.png, desktop/icon-1024.png`);
