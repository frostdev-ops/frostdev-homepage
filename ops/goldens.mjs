// Regenerates docs/goldens/*.png — the README's screenshots — from a
// throwaway instance: the example monitor list, a temp data dir, one demo
// user, the default layout. Nothing personal can appear in them.
//   node ops/goldens.mjs        (needs .env with TOKEN_ENC_KEY; ~2 min)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execSync } from 'node:child_process';
import { chromium } from 'playwright-core';

const PORT = 3222;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = 'docs/goldens';
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'goldens-'));
process.env.HOMEPAGE_DATA_DIR = data;

const targets = 'src/lib/targets.json';
const keep = fs.existsSync(targets) ? fs.readFileSync(targets) : null;
let server;
try {
  fs.copyFileSync('src/lib/targets.example.json', targets);
  execSync('npm run -s build', { stdio: 'inherit' });

  const { createUser } = await import('../src/lib/users.ts');
  const { createSession } = await import('../src/lib/auth.ts');
  const userId = createUser('demo@example.com', 'demo-' + Math.random().toString(36).slice(2), 'admin');
  const cookie = createSession(userId).id;

  server = spawn(process.execPath, ['--env-file=.env', 'server.mjs'], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', ASTRO_NODE_AUTOSTART: 'disabled' }, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${BASE}/login`)).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }

  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ channel: 'chromium', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.5, colorScheme: 'dark' });
  await ctx.addCookies([{ name: 'frost_session', value: cookie, url: BASE }]);
  const page = await ctx.newPage();
  const shot = async (url, name, wait = 2500) => {
    await page.goto(`${BASE}${url}`, { waitUntil: 'networkidle', timeout: 60_000 });
    await page.waitForTimeout(wait);
    await page.screenshot({ path: `${OUT}/${name}.png` });
    console.log('wrote', `${OUT}/${name}.png`);
  };
  await shot('/?still=1', 'splash', 4000);
  await shot('/dash', 'dashboard', 5000);
  await ctx.clearCookies();
  await shot('/login', 'login', 3000);
  await browser.close();
} finally {
  server?.kill('SIGTERM');
  if (keep) fs.writeFileSync(targets, keep);
  fs.rmSync(data, { recursive: true, force: true });
}
