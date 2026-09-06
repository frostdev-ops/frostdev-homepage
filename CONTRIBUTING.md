# Contributing

## Run it

```sh
npm install
cp .env.example .env                         # PUBLIC_BASE_URL and TOKEN_ENC_KEY at least
node bin/rimeward.mjs users create you@example.com --admin
npm run dev:env                              # http://localhost:4321
npm test                                     # node --test tests/*.test.ts
npm run typecheck
```

Every test file seeds its own temporary data directory (`tests/_setup.ts`, imported first) and
runs under Node's native type stripping, which is why relative TypeScript imports carry their
`.ts` extension everywhere. Keep both.

## The words

User-facing copy says **ward**, **leyline**, **Rime**, **routine**, **packet**. Identifiers,
routes, tables and CSS classes keep their engineering names (`WardInstance`, logic edges,
`.wiring`). A new ward type is one `CATALOG` entry in `src/lib/wards.ts` (with its `concepts` and
`does`, which the add dialog's search and the tests need) plus one renderer in
`src/scripts/app/wards.ts`.

## Changes

- One concern per pull request, with the test that fails without it.
- Nothing instance-specific in the tree: names, domains, addresses and the monitor list are
  settings, environment or `data/` (see `.env.example`, `src/lib/site.ts`, `src/lib/brand-files.ts`,
  the admin monitor registry).
- `npm run lint:desktop`, `npm test`, `npm run typecheck`, and `npm run build` green; the Tests workflow runs these on Linux and Windows on every push. Keep the test glob double-quoted so Windows runs the suite. Desktop lint treats warnings as failures and covers the native launcher, runtime, APIs, editor/terminal UI, and development styles.

## Desktop and remote workspaces

`npm run desktop:build` stages the pinned Node runtime, Chromium, application assets, and
native dependencies before Tauri builds. Build on the target platform; do not copy another
Node version's `better-sqlite3` or `node-pty` binaries into the payload. The desktop process
owns `workspaces.db`, recovery, PTYs, and agent tasks. The ordinary server must reject native
execution and persist only device pairing metadata. Keep relay paths free of payload logging
and persistent caching. See [the runtime contract and checks](docs/development-workspaces.md).

Rust 1.98.0 is pinned in `rust-toolchain.toml` and the release workflow so local and CI
diagnostics agree. The Tauri CLI is a pinned development dependency, excluded from the
bundled backend. After staging, run `npm run desktop:check`: Biome, Rust formatting, Clippy with warnings
as errors, and native unit tests. Desktop release Actions run this on each target; the release remains a draft until every platform succeeds. On macOS,
`desktop/sign-runtime.mjs` signs and verifies bundled Chromium and native binaries before
Tauri signs/notarizes the outer app. Build intermediates and other platforms' PTY prebuilds
are excluded. macOS copies the runtime as a whole directory to preserve signed framework
links. Linux builds DEB and AppImage packages; RPM is excluded because its packager stalls
on the bundled runtime, even with Zstandard compression. `desktop/entitlements.plist`
supplies the Node/Chromium JIT entitlements. Manual release dispatches must select the
version's existing tag; every build verifies that tag against its checked-out commit.

Install-script permissions are pinned in `package.json` for native dependencies. The SDK's
network-based model-type freshness check is disabled; models are discovered at runtime.
The current `just-bash` dependency emits Node's experimental `stripTypeScriptTypes` notice
when its JavaScript worker starts under Node 22. Its optional compression dependency also
uses the deprecated `prebuild-install` package. Node 22 also marks the built-in mock timers
used by Discord tests as experimental. These upstream/tooling notices are not suppressed.

After a web build, run `npm run test:ui` with the staged Chromium available. These checks
exercise real editor/PTY behavior, shared-client control, recovery, and isolated HTTPS
handoff. Conversation provider responses and native desktop UI operations are test adapters;
they do not authorize model calls or validate OS webviews. `npm run test:standalone` checks
the staged app with its bundled Node. Actual macOS, Windows, and Linux release behavior still
needs platform validation.

New UI controls use `icon()` or `<Icon>` with a semantic ID from `src/lib/icon-names.ts`.
Register the ID in every icon set. Keep user-authored emoji as content. CodeMirror's native
folding and diagnostic controls use the same theme contract. Preserve keyboard access,
reduced motion, editor recovery, and explicit terminal input ownership.

## Screenshots and release documentation

`npm run goldens` regenerates every image in `docs/goldens` from disposable users, projects,
and synthetic conversation data. It builds the app, captures the original dashboard screens,
and runs the editor, terminal, and conversation UI checks for desktop/phone screenshots.
It needs Chromium (`npx playwright-core install chromium` or `desktop/prebuild.mjs`) and
uses software rendering. Review every generated image before committing it. Goldens are
documentation screenshots, not pixel-diff assertions.

Update README, this guide, the security boundaries, and the workspace guide together when
changing setup or ownership. `docs/pages-spec.md` records the page model and its workspace
extension. Keep private deployment instructions (`AGENTS.md`, `CLAUDE.md`, local deployment
scripts) out of the public repository.
