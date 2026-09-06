# One Rimeward instance, across desktop and browser

The Tauri app runs the existing Astro 7 backend and Rimeward harness locally. Node 22.22.0 is a Tauri sidecar; application code, native dependencies, migrations, assets, and pinned Chromium are bundled for each target OS/architecture. The local owner is created on first launch. When a server is connected, the app shares its dashboard, pages, appearance, and Rime profile. Integration requests use that account automatically; credentials stay on the installation that holds them. Standalone installations can configure their own integrations. The desktop keeps a stable loopback port; register its displayed origin and callback paths with any OAuth clients you configure locally. Initial integration authorization is performed on the desktop.

## Use

1. Build with `npm run desktop:build` (Rust and platform build prerequisites required; `npm ci` installs the pinned Tauri CLI). No separate Node installation is required on the installed user's machine.
2. On first launch, enter your Rimeward address and approve the connection in your browser, or continue without connecting. **Open Rimeward** opens one dashboard. There is no local/server mode or workspace selector. The desktop shell always opens its authenticated local application so local projects keep working during an outage.
3. Choose **Open project**, then select an existing folder or create a named project. Opening a project reuses its existing page, or creates Editor and Rime side by side, with Terminal and Changes below. Rime inherits the page's project context and uses the existing desktop tools and session permissions. Existing layouts remain as configured; add a Rime ward to an older project page to use the same context. The Editor includes its own file explorer; Project files remains available as an optional ward. All other wards can still be added.
4. Open a file from the Editor’s left-hand explorer. Use Cmd/Ctrl+P for quick open, Cmd/Ctrl+S to save, and the **…** menu for find/replace, go to line, word wrap, formatting, and recovery history. File tabs preserve undo history; closing a dirty tab keeps its desktop recovery for the next time it opens. **Take over** transfers editing control. External changes to a dirty file show **Compare changes**, with a code diff and explicit version selection.
5. Choose **Open terminal** for a shell that is immediately ready to type into. **+** opens a new-session dialog for Shell, Codex, or Claude Code; optional shell and permission choices are under **More options**. Switch sessions in the top bar. Search with Cmd+F or Ctrl+Shift+F; Ctrl+F stays available to the shell. The **…** menu holds session settings, input release, interrupt, and **End session**. **Take control** appears when another client owns input; **Review & take control** reconciles uncertain input before continuing. Phone views show an extra-key strip; desktop users can enable it from the menu. Removing the ward only detaches its view; ending a process retains its saved screen, with **Start again** as a separate action.
6. Use the ordinary page tabs everywhere. Connecting brings the existing Home and other pages into the app, and publishes desktop project pages into the same dashboard. The app routes each ward to its owning computer or connected service. Project paths, file contents, recovery buffers, and native sessions are not replicated to the server. **Connections** is an account setting for pairing and revocation, not a mode switch. Browser approval uses a short-lived grant; device credentials stay in the OS vault. The old enrollment and browser-tunnel protocols remain compatible.

Codex and Claude Code must already be installed and signed in locally. Setup links are in session settings. No CLI or provider credential is installed or copied automatically. New sessions default to Human. Rimeward tools create Human sessions; delegated input requires a session configured by the user. Mode changes are stored as the next launch policy; **Start again** opens a new interface after the previous process ends, without replaying its task; active CLIs are never silently restarted. Human mode keeps interactive input with the user because terminal text cannot reliably distinguish permission prompts from arbitrary program output.

Only canonical `NNN_lowercase_name.sql` migrations are loaded. Finder/cloud conflict copies such as `001_init 2.sql` are ignored instead of being treated as new database migrations.

## One interface and automatic routing

The server and desktop share one dashboard record: pages, ward configuration, execution placement, theme, and display identity. On first connection the server supplies Home and appearance. Existing project pages and custom desktop wards are merged in; matching starter wards are not duplicated. Conflicting local IDs are remapped with their saved content, and a pre-join dashboard is retained locally. Subsequent changes use the same hash-based reconciliation and recoverable conflict handling as Rime's files.

Execution placement is internal metadata. Browser requests for a project ward are relayed to its computer; on that computer they stay local. Connected integration requests use the server's authenticated account without copying its secrets. Project Rime tools use local files and terminals while integration tools use the connected account. Streams from the relevant owners feed the same interface. An unavailable computer makes its tools unavailable; it does not replace the dashboard or replay an action.

All appearance knobs are shared, including light/dark mode, icon set/style/stroke/tint, fonts, colors, glass, scene backgrounds, and header scenes. Uploaded backgrounds and logos sync as content-addressed application assets. Their account-local filenames are remapped on receipt; image ownership checks remain intact. Instance brand assets are read from the server and cached on the desktop. Appearance assets remain available offline. Project folders are never part of this asset synchronization.

The native shell retains its restricted navigation commands for older bookmarks and browser clients, but normal navigation uses one page list and one origin. Phone clients stay on `/dash`; per-ward relay requests run underneath it. Offline desktop pages and saved appearance remain accessible, while services requiring the server report connection loss. Reconnection reconciles state without replaying terminal input or uncertain mutations.

## Editor analysis

CodeMirror provides editing, syntax support, completion, search/replace, and diff views. The pinned [Biome package](https://biomejs.dev/) supplies the actual lint and formatting rules; Rimeward has no custom linter. Live diagnostics cover JavaScript/TypeScript (including JSX/TSX), JSON/JSONC, CSS, GraphQL, and HTML. Other languages retain syntax support where available and explicitly show that no linter is configured. The **Problems** panel lists current-file diagnostics and jumps to their locations. Dark themes use CodeMirror’s One Dark syntax colors.

Interface icons use the selected icon or emoji pack, including editor folding, diagnostics, terminal keys, and conversation controls. Live changes preserve the configured style, tint, size, stroke, and opacity. User-authored emoji, reactions, and custom Notion icons remain content.

Analysis runs only on the desktop, in a private temporary directory with a bundled recommended configuration. It does not load project plugins or execute project scripts. Temporary buffers are removed after the check; no content is sent to a third-party lint service. Checks are debounced and limited to 1 MiB, 100 displayed diagnostics, two concurrent processes, and ten seconds. **Format document** changes the recovery buffer; **Save** is still required to change the working file. Project-specific linter configuration and language-server integration can be added separately.

## Conversation controls

The first configured server is the shared Rime profile. New agent wards use **Rime default**, inheriting its provider/model/persona; explicit ward choices still apply. Account → Agent shows the active connection and labels local credentials as fallbacks. Codex model suggestions come from the server account. The model endpoint only performs inference: the desktop harness retains its loop, local tools, and terminal permission checks. Provider keys and OAuth refresh tokens are not copied. If the server is unavailable, local files/history remain usable and an independently configured local provider can run new turns. Without one, the current transcript remains visible, sending is disabled, and Rime explains the offline setup requirement.

Rime's own `/work` files (including `AGENTS.md`, memory, skill folders, and scratch files), attachments, and complete chat transcripts/raw provider items synchronize through an additive per-account journal. No project root is traversed. Hash manifests transfer changed records; file deletes use tombstones. Reconnect uses base hashes rather than timestamps. Server versions win simultaneous file conflicts, with the complete local version retained under **Chat history → Recovered version** and an explicit restore action. Only regular files are accepted; symlinks, hardlinks, path traversal, files above 32 MiB, and more than 10,000 work files stop sync with a visible error. Polling is every 15 seconds and after turns. A different server account cannot silently receive a previously linked profile.

**Chat history** shows conversations from the server and desktop. **Continue here** makes a local continuation while preserving the original thread and any tasks still running there. It remaps attachments and retains provider replay items, but never imports pending confirmations, scheduled actions, or process state. Shared transcripts may contain code excerpts and tool output. Those are shared agent data; raw project folders, editor recovery, and native terminal sessions remain desktop-owned.

Agent wards and expanded chat share a composer. Draft text and attachments follow the ward when it expands or closes; drafts remain in memory for the current page, with no copy in a remote browser's persistent storage. Desktop Enter sends and Shift+Enter adds a line; on touch devices Enter adds a line and the Send button sends. IME confirmation does not send. Drop or paste files into chat, copy replies or code blocks, and open the activity summary to inspect tool results. New chat archives the current conversation only after the server confirms the request. While Rime works, Stop interrupts it and a new message steers the turn. Reading earlier replies holds the scroll position; Latest returns to the newest activity. Animations respect reduced-motion settings.

Connected messaging wards also support multiline drafts and retain them through feed refreshes, scoped to their channel.

## Ownership and transport

- `homepage.db` and the existing harness run independently on each installation. `workspaces.db` stores desktop projects, recovery buffers, session screens, assignments, and review receipts. OS credential storage holds the encryption key and pairing credentials. PTY/Git environments exclude backend secrets.
- The server stores device pairing metadata and the explicitly shared Rime journal. An authenticated control connection creates an in-memory, backpressured WebSocket channel for each relayed HTTP exchange. Native workspace databases and project folders are not replicated. There is no disconnected project-mutation queue.
- Normal `/dash` pages share one dashboard. Stored ward/page placement routes native APIs and live events to the owning desktop automatically. `/runtime/<device>/…` remains the authenticated transport namespace and supports older links. Its runtime bridge routes fetch/EventSource/media operations before legacy application scripts execute. The desktop resolves its own local owner; server user IDs and cookies never become local identities.
- Reconnection reads terminal sequence snapshots and editor revisions. Failed/uncertain mutations and terminal input are not retried automatically. Explicit revocation closes existing channels. Existing `/api/tunnel` browser clients retain their protocol. Opening an approved server dashboard starts its home route; native browser commands are restricted to that origin, and profiles are separated by server and paired device. Disconnects cancel stream tasks and release browser usage counts.
- Terminals remain alive while views close. Explicit application exit requests graceful backend/browser/PTY shutdown. Restarted processes are reported as exited/interrupted, not resumed.
- Git coordination is advisory for external CLI writes. Managed worktree operations serialize on the repository's common Git directory and reject dirty worktrees, unsaved editor recovery, or running sessions.

## Server configuration required for remote access

Install [the relay nginx locations](../ops/runtime-relay.nginx.conf) inside the server block before exposing `/runtime/`. Disable edge/CDN caching, request capture, analytics payload capture, and error-body recording for that namespace, automatically routed ward APIs, the device connection, and `/api/devices/harness`. The application sets no-store headers. Only the explicit Rime sync endpoint persists shared records; project relay payloads remain transient. HTTPS/WSS is required; the server is trusted and this is not end-to-end encrypted against its operator.

For nginx, copy the snippet to `/etc/nginx/snippets/rimeward-runtime-relay.conf` and use
the include in [the example vhost](../ops/nginx.example.conf). Run `nginx -t` before
reloading. The server listens on loopback behind nginx; leave desktop-only environment
flags unset. Keep the existing `/api/tunnel` websocket route for older clients and stream
`/api/logic/stream` without buffering for chat and layout updates.

[Cloudflare templates](../ops/cloudflare-relay.json) add two narrowly scoped rules:
cache bypass and content settings for `/runtime/`, `/api/devices/connect`, `/api/devices/harness`, and automatically routed development, agent, browser, note, and instance APIs. Add these
rules to the zone's existing phase rulesets without replacing unrelated rules. They turn
off RUM/Zaraz, Rocket Loader, email rewriting, and body buffering for the relay.
Cloudflare's [configuration settings](https://developers.cloudflare.com/rules/configuration-rules/settings/)
document these controls; body inspection is intentionally unavailable on this authenticated
stream. Keep application authentication in place. Check legacy Page Rules, Workers routes,
Logpush jobs, security payload capture, and any additional proxy when applying this setup.

Before deployment, create an online backup of the server database and its data directory,
retain its encryption key securely, and save the current application and proxy configuration
for rollback. Server migrations are additive and run when the database first opens. Install
the matching lockfile dependencies, build with a version/commit stamp, and reload the process
manager with graceful shutdown enabled. Verify the public login/dashboard, device authorization,
an authenticated WSS connection, streamed requests/uploads, cache headers, revocation, and
desktop-offline behavior. Inspect origin logs, database, cache/temp paths, and backup output
for a unique test marker. Remove disposable test accounts and devices afterward.

## Checks

- `npm test` — existing regression tests plus root confinement, recovery/version conflicts, PTY ownership, CLI launch flags, worktree safety, relay identity isolation/revocation, and non-replication checks.
- `npm run typecheck` and `npm run build`.
- `npm run desktop:check` after staging — desktop Biome lint (warnings fail), Rust format check, Clippy with `-D warnings`, and native tests.
- `node tests/standalone-smoke.mjs` after `node desktop/prebuild.mjs` — bundled-Node startup/authentication, dashboard, recovery, real PTY, shutdown/restart.
- `node tests/remote-workspace-smoke.mjs` after building — first-run browser login/approval, existing server dashboard, project creation from an empty terminal, the Open project flow, inherited Rime provider access, shared history continuation, offline memory edits, conflict recovery, unified page navigation and desktop/phone handoff, shared terminal input and editor recovery, and server data/log project-marker checks. Requires OpenSSL and bundled Chromium. Native folder/browser/cookie operations use a test adapter; this does not verify the actual macOS webview, native dialogs, or external model-provider calls.
- `node tests/conversation-ui-smoke.mjs` after building — desktop/phone chat layout, draft isolation, uploads, IME/Enter behavior, copy controls, error recovery, new chat, activity, approvals, reading position, reduced motion, and messaging drafts. Uses synthetic provider/transport responses; sends no external messages or model requests.
- `node tests/editor-ui-smoke.mjs` after building — integrated explorer, reusable project pages, tabs/undo/recovery, real Biome diagnostics and formatting, find/replace, quick open, create/rename, external conflict diffs, mobile takeover, and read-only files. Uses an isolated desktop and headless Chromium, with no model calls.
- `node tests/terminal-ui-smoke.mjs` after building — real PTY through the terminal UI: one-click launch/control, search, menus inside expansion, session switching, lost input acknowledgements, phone takeover, permission configuration, and end/restart. Launcher guidance is tested without starting Codex/Claude or sending model requests.
- `node tests/cli-launch-smoke.mjs` — optional installed-Codex/Claude interactive launch checks in each permission mode; no tasks, approval responses, or model requests are sent.
- `npm run test:ui` runs the four editor, terminal, conversation, and remote-handoff scripts in order; `npm run test:standalone` checks the staged runtime. `npm run goldens` rebuilds and regenerates the original six dashboard images plus editor, terminal, and chat screenshots on desktop and phone. These are documentation goldens; the smoke tests assert behavior and layout separately.

macOS release packaging signs nested Chromium apps, frameworks, executables, and native modules before Tauri signs and notarizes the outer app. CI verifies nested signatures and excludes native build intermediates from the payload.

Release validation still requires signed installers and native PTY/credential-store behavior on Windows and Linux, physical mobile touch/IME testing, real delegated-agent task/approval flows, and checking production proxy/edge logs, caches, temporary files, and backups. Automated browser emulation is not a substitute for those checks. Language servers, cross-file type checking, debugging, and VS Code extension compatibility are not included.

## macOS shutdown investigation

The September 5 WindowServer report recorded a 40-second watchdog timeout; it does not establish which app triggered it. A separate Rimeward hang report showed its main thread waiting during Quit. Shutdown previously called `block_on` from the UI event callback. It now defers exit, awaits backend/browser cleanup asynchronously, and exits after cleanup, without blocking the event loop. The WindowServer trigger remains unconfirmed; the app was not relaunched to try reproducing a system-wide failure.
