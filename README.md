<p align="center">
  <img src="assets/rimeward-lockup.svg" alt="Rimeward by frostdev" width="560">
</p>

<p align="center">
  The public splash at <a href="https://frostdev.io">frostdev.io</a>, the <b>Rimeward</b> dashboard behind the login, and the Rimeward desktop app.
  <br>
  <a href="https://github.com/frostdev-ops/frostdev-homepage/releases/latest">Latest desktop release</a> · macOS (signed, universal) · Windows · Linux
</p>

Rimeward is a personal operations dashboard: live service status for your own servers,
weather, one inbox over every linked mailbox, a merged agenda, Notion wards, a notepad,
routine timers, chat wards (Discord, Telegram, Slack, Twilio, push, Matrix, Teams), a real
browser you and the built-in agent drive together, and **leylines**, a small automation graph
that wires any of it to any of it.

## Screens

<p align="center">
  <img src="docs/goldens/splash.png" alt="The splash: living topography" width="880">
</p>
<p align="center">
  <img src="docs/goldens/dashboard.png" alt="The dashboard, default layout" width="880">
</p>

## The words

Rimeward has its own vocabulary, and the code follows it.

**Frostdev** is the studio and the public site. **Rimeward** is the private dashboard behind the
login and the desktop app. Rime is the frost that grows on the windward side of things; Rimeward is
where you keep watch.

A **ward** is one card on the dashboard. Every ward is one thing to watch or one thing to do: the
weather, an inbox, a Notion database, a routine timer, a real browser. Wards come from a catalog,
grouped by what they are for: *At a glance*, *Mail*, *Chat & messaging*, *Notion*, *Write &
capture*, *Leylines & automation*, *Rime*, and *Layout & looks*. Wards live on **pages**, the tabs
across the top; a **container** groups wards; a **spacer** is breathing room.

<p align="center">
  <img src="docs/goldens/wards.png" alt="The ward catalog, in edit mode" width="880">
</p>

A **leyline** is a wire from something that happens in one ward to something another ward does:
a routine finishing, a button being pressed, a service going down, mail arriving, a message in a
chat, the weather turning; then a timer starts, a Notion task is checked, a message is sent, a
flow packet moves, Rime is asked. A leyline can carry conditions, and every leyline is one
trigger, one action; fan-out is more leylines. **Leylines mode** is where you draw them, across
every page at once.

<p align="center">
  <img src="docs/goldens/leylines.png" alt="Leylines mode" width="880">
</p>

**Rime** is the agent that lives in the dashboard. It reads the same wards you do, keeps its own
memory and skills as wards, drives the same browser you drive, and asks before anything leaves
the building: mail, chat, and the rest of the outbound tools wait for a confirm. A **routine** is
a timer with rounds. A **packet** is what moves between flow wards. The **home route** is the
desktop app's tunnel: a browser ward on the server egressing from your own connection, or running
its Chromium on your machine entirely.

<p align="center">
  <img src="docs/goldens/rime.png" alt="The Rime ward" width="430">
  <img src="docs/goldens/browser.png" alt="A browser ward" width="430">
</p>

In the code the words keep their engineering names where they were there first: a ward is a
`WardInstance` from the `CATALOG` in `src/lib/wards.ts`; leylines are logic edges in
`src/lib/logic*.ts` (triggers, conditions, actions, the `.wiring` mode); Rime is `src/lib/agent/`.
User-facing copy always says ward, leyline, Rime.

## Stack

Astro 5 (SSR, Node adapter) · TypeScript · Tailwind 4 · SQLite (`better-sqlite3`) · three.js
for the splash · Playwright for the browser wards · Tauri 2 (Rust) for the desktop app.

## Run it

```sh
npm install
cp .env.example .env            # fill in what you use; TOKEN_ENC_KEY is required
cp src/lib/targets.example.json src/lib/targets.json   # what the status wards monitor
npm run dev:env                 # http://localhost:4321 (.env loaded)
npm test                        # node --test
npm run build && npm run preview
```

The first user to sign in becomes the admin. `server.mjs` is the production entry (Astro's
standalone server plus the websocket upgrade the desktop app needs); run it behind a reverse
proxy that passes `Upgrade` headers on `/api/tunnel`.

## Desktop app

`desktop/` is a Rust-only Tauri 2 app whose window loads the dashboard. It keeps a tunnel open
to the server so a browser ward can either egress from your own connection or run its Chromium
on your machine entirely, driven from the dashboard and by the agent alike.

```sh
cargo install tauri-cli --locked
npm run desktop:dev             # against the dev server
npm run desktop:build
```

Releases are built by `.github/workflows/desktop.yml` on a `desktop-v*` tag.

## Layout

- `src/pages` routes · `src/lib` the server (auth, wards, status, logic engine, agent, tunnel,
  browser sessions, comms) · `src/scripts/app` the dashboard client · `src/styles/frost.css`
  the token system
- `migrations/` numbered SQL, applied on first open
- `desktop/` the Tauri app · `ops/rimeward-brand.mjs` regenerates the mark, lockup and icon

## License

[MIT](LICENSE)
