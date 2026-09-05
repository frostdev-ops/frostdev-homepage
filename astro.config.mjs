// @ts-check
import { defineConfig, fontProviders } from 'astro/config';
import node from '@astrojs/node';
import tailwindcss from '@tailwindcss/vite';

// The font catalogue lives in ONE place — src/lib/theme.ts — and this derives
// the build's download list from it, so `var(--font-<id>)` always resolves for
// every face a picker offers. Adding a font is one entry there.
import { FONTS, PREVIEW_GLYPHS } from './src/lib/theme.ts';

// Every family is registered TWICE: the real face, and a `-p` twin subset to
// just the glyphs a picker label uses. Astro hashes the whole family config
// into the @font-face name, so the same family under two cssVariables is two
// independent faces — which is what lets a picker preview 43 fonts for ~130KB
// instead of pulling every full charset (~1.4MB).
const FONT_FACES = Object.entries(FONTS).flatMap(([id, f]) => {
    const g = f.google;
    if (!g) return [];
    const base = {
      provider: fontProviders.google(),
      name: g.name,
      styles: /** @type {['normal']} */ (['normal']),
      subsets: /** @type {['latin']} */ (['latin']),
      fallbacks: /** @type {[string]} */ ([g.fallback]),
      // Fallback text stays visible while the face downloads.
      display: /** @type {const} */ ('swap'),
    };
    return [
      { ...base, cssVariable: `--font-${id}`, weights: /** @type {[string, ...string[]]} */ (g.weights) },
      {
        ...base,
        cssVariable: `--font-${id}-p`,
        // One weight, and no metric-matched fallback face: a dropdown row is
        // not something layout shift matters in.
        weights: /** @type {['400']} */ (['400']),
        optimizedFallbacks: false,
        options: { experimental: { glyphs: PREVIEW_GLYPHS } },
      },
    ];
  });

export default defineConfig({
  output: 'server',
  adapter: node({ mode: 'standalone' }),
  integrations: [
    {
      // Dev only: the desktop app's tunnel (src/lib/tunnel.ts) needs the raw
      // `upgrade` event, which no Astro route can see. Prod does the same in
      // server.mjs. Vite's own HMR socket upgrades here too — left alone.
      name: 'tunnel-dev',
      hooks: {
        'astro:server:setup': ({ server }) => {
          server.httpServer?.on('upgrade', (req, sock, head) => {
            if (!req.url?.startsWith('/api/tunnel')) return;
            const h = /** @type {any} */ (globalThis).__fdUpgrade;
            if (h) h(req, sock, head);
            else sock.end('HTTP/1.1 503 Service Unavailable\r\ncontent-length: 0\r\n\r\n');
          });
        },
      },
    },
  ],
  // Still `experimental` on Astro 5 — a top-level `fonts` key is an Astro 6
  // thing and is silently IGNORED here, which looks exactly like a build that
  // works and a font that never downloads.
  experimental: { fonts: FONT_FACES },
  // Without this, Astro rewrites every request host to "localhost" and the
  // built-in CSRF origin check 403s all form POSTs behind the nginx proxy.
  security: {
    allowedDomains: [
      { hostname: 'frostdev.io', protocol: 'https' },
      { hostname: 'www.frostdev.io', protocol: 'https' },
      { hostname: '127.0.0.1' },
      { hostname: 'localhost' },
    ],
  },
  vite: {
    plugins: [/** @type {any} */ (tailwindcss())],
    // better-sqlite3 is a native module — never bundle it.
    ssr: { external: ['better-sqlite3'] },
  },
});
