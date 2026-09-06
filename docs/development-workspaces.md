# Standalone development workspaces

The Tauri app runs the existing Astro 7 backend and Rimeward harness locally. Node 22.22.0 is a Tauri sidecar; application code, native dependencies, migrations, assets, and pinned Chromium are bundled for each target OS/architecture. The local owner is created on first launch. Account integrations are configured independently on each installation. The desktop keeps a stable loopback port; register its displayed origin and callback paths with any OAuth clients you configure locally. Initial integration authorization is performed on the desktop.

## Use

1. Build with `npm run desktop:build` (Rust and platform build prerequisites required; `npm ci` installs the pinned Tauri CLI). No separate Node installation is required on the installed user's machine.
2. On first launch, choose **Bring your dashboard** or **Start right here**. Connecting needs just the server address: approve the request in your browser using the server's normal login, then choose **Open server dashboard**. The app remembers that starting workspace. If the server is unavailable, local work remains accessible; the tray also has **Open this desktop**.
3. Choose **Open project**, then select an existing folder or create a named project. Opening a project reuses its existing page, or creates Editor and Rime side by side, with Terminal and Changes below. Rime inherits the page's project context and uses the existing desktop tools and session permissions. Existing layouts remain as configured; add a Rime ward to an older project page to use the same context. The Editor includes its own file explorer; Project files remains available as an optional ward. All other wards can still be added.
4. Open a file from the Editor’s left-hand explorer. Use Cmd/Ctrl+P for quick open, Cmd/Ctrl+S to save, and the **…** menu for find/replace, go to line, word wrap, formatting, and recovery history. File tabs preserve undo history; closing a dirty tab keeps its desktop recovery for the next time it opens. **Take over** transfers editing control. External changes to a dirty file show **Compare changes**, with a code diff and explicit version selection.
5. Choose **Open terminal** for a shell that is immediately ready to type into. **+** opens a new-session dialog for Shell, Codex, or Claude Code; optional shell and permission choices are under **More options**. Switch sessions in the top bar. Search with Cmd+F or Ctrl+Shift+F; Ctrl+F stays available to the shell. The **…** menu holds session settings, input release, interrupt, and **End session**. **Take control** appears when another client owns input; **Review & take control** reconciles uncertain input before continuing. Phone views show an extra-key strip; desktop users can enable it from the menu. Removing the ward only detaches its view; ending a process retains its saved screen, with **Start again** as a separate action.
6. Open **Workspaces** in the header to search server pages and connected computers together. On the computer running the app, its workspace opens directly over authenticated loopback; phones use the live relay. The last page is remembered on its owning runtime, so returning from another device reopens that page, editor tabs, and terminal sessions. Switching waits for editor recovery to be acknowledged; it does not save working files or restart tasks. Use **Connections** to connect another server. Browser approval uses a short-lived device authorization grant; its polling secret stays in the local backend. Pairing credentials stay in the OS vault, and the native shell installs the server session into its webview without exposing it to page JavaScript. Revocation closes relay channels and ends device-issued server sessions. The old enrollment-code API remains compatible. Both the desktop and server need this update.

Codex and Claude Code must already be installed and signed in locally. Setup links are in session settings. No CLI or provider credential is installed or copied automatically. New sessions default to Human. Rimeward tools create Human sessions; delegated input requires a session configured by the user. Mode changes are stored as the next launch policy; **Start again** opens a new interface after the previous process ends, without replaying its task; active CLIs are never silently restarted. Human mode keeps interactive input with the user because terminal text cannot reliably distinguish permission prompts from arbitrary program output.

Only canonical `NNN_lowercase_name.sql` migrations are loaded. Finder/cloud conflict copies such as `001_init 2.sql` are ignored instead of being treated as new database migrations.

## Navigation and live continuity

The workspace navigator replaces the old Environment dropdown and separate local-mode banner. It lists pages under their owning server or computer, with connection status and search. Navigation metadata contains page IDs/titles and the last active page, never filesystem roots or buffer contents. Local and relayed clients use the same runtime and recovery/session stores. No project-folder synchronization job or server copy of project files is created; remote editing saves on the owning computer only when Save is requested.

The native shell exposes only `workspace_navigation` and `open_workspace` to its loopback origin and the approved active server. It validates the requesting webview origin again, keeps the loopback token in Rust, and permits only app-owned navigation destinations. Browser clients cannot relay pairing or native navigation operations. The server's device navigation endpoint authenticates the device credential and resolves its server account independently of the local owner.

Switching back to a server reuses its in-memory session and existing browser tunnel. It does not close browser wards simply because the page changed. Offline desktop documents include a server-dashboard link and an explicit reconnect action; neither path replays input. Older installed desktop clients retain web navigation and are told to update for direct native access. The mobile header keeps Notion search behind an accessible search button so workspace navigation stays usable.

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
- `/runtime/<device>/…` selects the desktop. Its own application HTML, assets, media, uploads, streams, and API calls pass through that namespace. The early runtime bridge routes client fetch/EventSource/media operations before application scripts execute. The desktop resolves its own local owner; server user IDs and cookies never become local identities.
- Reconnection reads terminal sequence snapshots and editor revisions. Failed/uncertain mutations and terminal input are not retried automatically. Explicit revocation closes existing channels. Existing `/api/tunnel` browser clients retain their protocol. Opening an approved server dashboard starts its home route; native browser commands are restricted to that origin, and profiles are separated by server and paired device. Disconnects cancel stream tasks and release browser usage counts.
- Terminals remain alive while views close. Explicit application exit requests graceful backend/browser/PTY shutdown. Restarted processes are reported as exited/interrupted, not resumed.
- Git coordination is advisory for external CLI writes. Managed worktree operations serialize on the repository's common Git directory and reject dirty worktrees, unsaved editor recovery, or running sessions.

## Server configuration required for remote access

Install [the relay nginx locations](../ops/runtime-relay.nginx.conf) inside the server block before exposing `/runtime/`. Disable edge/CDN caching, request capture, analytics payload capture, and error-body recording for that namespace, the device connection, and `/api/devices/harness`. The application sets no-store headers. Only the explicit Rime sync endpoint persists shared records; project relay payloads remain transient. HTTPS/WSS is required; the server is trusted and this is not end-to-end encrypted against its operator.

For nginx, copy the snippet to `/etc/nginx/snippets/rimeward-runtime-relay.conf` and use
the include in [the example vhost](../ops/nginx.example.conf). Run `nginx -t` before
reloading. The server listens on loopback behind nginx; leave desktop-only environment
flags unset. Keep the existing `/api/tunnel` websocket route for older clients and stream
`/api/logic/stream` without buffering for chat and layout updates.

[Cloudflare templates](../ops/cloudflare-relay.json) add two narrowly scoped rules:
cache bypass and content settings for `/runtime/`, `/api/devices/connect`, and `/api/devices/harness`. Add these
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
- `node tests/remote-workspace-smoke.mjs` after building — first-run browser login/approval, existing server dashboard, project creation from an empty terminal, the Open project flow, inherited Rime provider access, shared history continuation, offline memory edits, conflict recovery, desktop/server handoff, shared terminal input and editor recovery, and server data/log project-marker checks. Requires OpenSSL and bundled Chromium. Native folder/browser/cookie operations use a test adapter; this does not verify the actual macOS webview, native dialogs, or external model-provider calls.
- `node tests/conversation-ui-smoke.mjs` after building — desktop/phone chat layout, draft isolation, uploads, IME/Enter behavior, copy controls, error recovery, new chat, activity, approvals, reading position, reduced motion, and messaging drafts. Uses synthetic provider/transport responses; sends no external messages or model requests.
- `node tests/editor-ui-smoke.mjs` after building — integrated explorer, reusable project pages, tabs/undo/recovery, real Biome diagnostics and formatting, find/replace, quick open, create/rename, external conflict diffs, mobile takeover, and read-only files. Uses an isolated desktop and headless Chromium, with no model calls.
- `node tests/terminal-ui-smoke.mjs` after building — real PTY through the terminal UI: one-click launch/control, search, menus inside expansion, session switching, lost input acknowledgements, phone takeover, permission configuration, and end/restart. Launcher guidance is tested without starting Codex/Claude or sending model requests.
- `node tests/cli-launch-smoke.mjs` — optional installed-Codex/Claude interactive launch checks in each permission mode; no tasks, approval responses, or model requests are sent.
- `npm run test:ui` runs the four editor, terminal, conversation, and remote-handoff scripts in order; `npm run test:standalone` checks the staged runtime. `npm run goldens` rebuilds and regenerates the original six dashboard images plus editor, terminal, and chat screenshots on desktop and phone. These are documentation goldens; the smoke tests assert behavior and layout separately.

macOS release packaging signs nested Chromium apps, frameworks, executables, and native modules before Tauri signs and notarizes the outer app. CI verifies nested signatures and excludes native build intermediates from the payload.

Release validation still requires signed installers and native PTY/credential-store behavior on Windows and Linux, physical mobile touch/IME testing, real delegated-agent task/approval flows, and checking production proxy/edge logs, caches, temporary files, and backups. Automated browser emulation is not a substitute for those checks. Language servers, cross-file type checking, debugging, and VS Code extension compatibility are not included.

## macOS shutdown investigation

The September 5 WindowServer report recorded a 40-second watchdog timeout; it does not establish which app triggered it. A separate Rimeward hang report showed its main thread waiting during Quit. Shutdown previously called `block_on` from the UI event callback. It now defers exit, awaits backend/browser cleanup asynchronously, and exits after cleanup, without blocking the event loop. The WindowServer trigger remains unconfirmed; the app was not relaunched to try reproducing a system-wide failure.
