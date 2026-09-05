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
  `src/lib/targets.example.json`).
- `npm test` and `npx tsc --noEmit` green; the Tests workflow runs both on every push.
