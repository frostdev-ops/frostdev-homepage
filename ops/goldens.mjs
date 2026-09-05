// Regenerates docs/goldens/*.png — the README's screenshots — from a
// throwaway instance: the example monitor list, a temp data dir, one demo
// user, the default layout. Nothing personal can appear in them.
//   node ops/goldens.mjs        (~3 min; no .env needed)
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execSync } from 'node:child_process';
import { chromium } from 'playwright-core';
import sharp from 'sharp';

const PORT = 3222;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = 'docs/goldens';
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'goldens-'));
process.env.HOMEPAGE_DATA_DIR = data;
process.env.TOKEN_ENC_KEY = crypto.randomBytes(32).toString('base64'); // this instance's own seal

const targets = 'src/lib/targets.json';
const keep = fs.existsSync(targets) ? fs.readFileSync(targets) : null;
let server;
try {
  fs.copyFileSync('src/lib/targets.example.json', targets);
  execSync('npm run -s build', { stdio: 'inherit' });

  const { createUser } = await import('../src/lib/users.ts');
  const { createSession } = await import('../src/lib/auth.ts');
  const { DEFAULT_LAYOUT, validateLayout } = await import('../src/lib/wards.ts');
  const { saveDashboard } = await import('../src/lib/dashboard.ts');
  const { validateGraph } = await import('../src/lib/logic.ts');
  const { saveGraph } = await import('../src/lib/logic-engine.ts');
  const userId = createUser('demo@example.com', 'demo-' + Math.random().toString(36).slice(2), 'admin');
  const cookie = createSession(userId).id;

  // The default layout plus the wards the vocabulary section shows: Rime, a
  // browser, a routine, a button, a flow, a notepad — and a few leylines.
  const layout = validateLayout([
    { i: 'rime', type: 'agent', size: '3x2', config: { provider: 'codex' } },
    { i: 'bw', type: 'browser', size: '3x2', config: { url: 'https://frostdev.io', backend: 'local' } },
    { i: 't1', type: 'timer', size: '1x1', title: 'Focus', config: { duration: 1500, rounds: 4 } },
    { i: 'b1', type: 'button', size: '1x1', title: 'Ask Rime' },
    { i: 'f1', type: 'flow', size: '2x2' },
    { i: 'n1', type: 'note', size: '2x2' },
    ...DEFAULT_LAYOUT,
  ]);
  saveDashboard(userId, layout);
  // A placeholder provider account, so the Rime ward shows its composer rather than a setup prompt.
  const { storeAgentAccount } = await import('../src/lib/agent/accounts.ts');
  storeAgentAccount({ userId, provider: 'codex', token: 'demo', label: 'demo@example.com' });
  const candidates = [
    { id: 'e1', source: { ward: 't1', trigger: 'timer-finished', params: {} }, conditions: [], action: { type: 'flow.emit', ward: 'f1', params: { channel: 'inbox', text: 'break over {{now}}' } }, enabled: true },
    { id: 'e2', source: { ward: 'b1', trigger: 'button-pressed', params: {} }, conditions: [], action: { type: 'agent.ask', ward: 'rime', params: { text: 'What changed today?' } }, enabled: true },
    { id: 'e3', source: { ward: 'n1', trigger: 'every', params: { minutes: 30 } }, conditions: [], action: { type: 'notify.flash', params: { text: 'Stretch' } }, enabled: true },
    { id: 'e4', source: { ward: 'rime', trigger: 'agent-replied', params: {} }, conditions: [], action: { type: 'flow.emit', ward: 'f1', params: { channel: 'rime', text: '{{text}}' } }, enabled: true },
  ];
  const edges = candidates.filter((e) => validateGraph({ edges: [e] }, layout, { isAdmin: true }));
  console.log('leylines seeded:', edges.map((e) => e.id).join(' '));
  saveGraph(userId, { edges });

  server = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', ASTRO_NODE_AUTOSTART: 'disabled' }, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${BASE}/login`)).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }

  fs.mkdirSync(OUT, { recursive: true });
  // Every golden sits in the same frame: the brand's navy, rounded corners,
  // a thin frost border — so they read as one set on the README.
  const frame = async (file) => {
    const img = sharp(file);
    const { width: w, height: h } = await img.metadata();
    const r = 18, pad = 36;
    const mask = Buffer.from(`<svg width="${w}" height="${h}"><rect width="${w}" height="${h}" rx="${r}" fill="#fff"/></svg>`);
    const rounded = await img.composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer();
    const border = Buffer.from(`<svg width="${w + pad * 2}" height="${h + pad * 2}"><rect x="${pad - 1}" y="${pad - 1}" width="${w + 2}" height="${h + 2}" rx="${r + 1}" fill="none" stroke="rgb(111 220 255 / 0.22)" stroke-width="2"/></svg>`);
    await sharp({ create: { width: w + pad * 2, height: h + pad * 2, channels: 4, background: '#0d1b2e' } })
      .composite([{ input: rounded, left: pad, top: pad }, { input: border, left: 0, top: 0 }])
      .png({ compressionLevel: 9 })
      .toFile(file + '.tmp');
    fs.renameSync(file + '.tmp', file);
  };
  const browser = await chromium.launch({ channel: 'chromium', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.5, colorScheme: 'dark' });
  await ctx.addCookies([{ name: 'rimeward_session', value: cookie, url: BASE }]);
  const page = await ctx.newPage();
  const shot = async (url, name, wait = 2500) => {
    await page.goto(`${BASE}${url}`, { waitUntil: 'networkidle', timeout: 60_000 });
    await page.waitForTimeout(wait);
    await page.screenshot({ path: `${OUT}/${name}.png` });
    await frame(`${OUT}/${name}.png`);
    console.log('wrote', `${OUT}/${name}.png`);
  };
  await shot('/?still=1', 'splash', 4000);
  await shot('/dash', 'dashboard', 16000); // the browser ward's chromium needs time for its first frame
  // The vocabulary: a ward up close, Rime, Leylines mode, the catalog.
  const el = async (sel, name) => {
    await page.locator(sel).first().screenshot({ path: `${OUT}/${name}.png` });
    await frame(`${OUT}/${name}.png`);
    console.log('wrote', `${OUT}/${name}.png`);
  };
  await el('[data-wd="rime"]', 'rime');
  await el('[data-wd="bw"]', 'browser');
  await page.click('#wd-toolbar [data-tb="logic"]');
  await page.waitForTimeout(3000);
  await page.screenshot({ path: `${OUT}/leylines.png` });
  await frame(`${OUT}/leylines.png`);
  console.log('wrote', `${OUT}/leylines.png`);
  await page.goto(`${BASE}/dash`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);
  await page.click('#wd-toolbar [data-tb="edit"]');
  await page.waitForTimeout(800);
  await page.click('#wd-toolbar [data-tb="add"]');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/wards.png` });
  await frame(`${OUT}/wards.png`);
  console.log('wrote', `${OUT}/wards.png`);
  await browser.close();
} finally {
  if (server) {
    // Graceful: the browser ward's chromium flushes its profile on the way out.
    server.kill('SIGTERM');
    await new Promise((r) => {
      server.once('exit', r);
      setTimeout(r, 10_000);
    });
  }
  if (keep) fs.writeFileSync(targets, keep);
  fs.rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}
