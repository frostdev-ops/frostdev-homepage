import { icon } from "./icon.ts";
import { chooseProject, askText, confirmAction, dialog as workspaceDialog } from "./workspace-dialogs.ts";
import { RENDERERS, body, poll } from "./wards.ts";
import { el, toast } from "./dom.ts";
import { readPages, pageOfCard } from "./pages.ts";
import { CATALOG, type WardInstance } from "../../lib/wards.ts";
import {
  DEV_WARDS,
  type Project,
  type SessionView,
  type TerminalKind,
} from "../../lib/dev/types.ts";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import "@xterm/xterm/css/xterm.css";
import "../../styles/development.css";

const owner = "client:" + crypto.randomUUID();
async function api(
  action: string,
  data: Record<string, unknown> = {},
  method = "GET",
): Promise<any> {
  const response = await fetch(
    "/api/dev/" +
      action +
      (method === "GET"
        ? "?" + new URLSearchParams(data as Record<string, string>)
        : ""),
    {
      method,
      cache: "no-store",
      ...(method === "GET"
        ? {}
        : {
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ...data, owner }),
          }),
    },
  );
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? "Desktop unavailable.");
  return value;
}
const button = (label: string, fn: () => unknown) => {
  const b = el("button", "btn text-xs", label);
  b.type = "button";
  b.onclick = () => {
    Promise.resolve()
      .then(fn)
      .catch((e) => toast(e.message, undefined, true));
  };
  return b;
};
const input = (label: string) => {
  const i = el("input", "input text-xs");
  i.placeholder = label;
  i.setAttribute("aria-label", label);
  return i;
};
const select = (label: string, choices: string[]) => {
  const s = el("select", "input text-xs");
  s.setAttribute("aria-label", label);
  for (const c of choices) s.add(new Option(c, c));
  return s;
};
const states = new Map<string, { stop: () => void }>();
function expand(host: HTMLElement) {
  const placeholder = document.createComment("expanded ward"),
    dlg = el("dialog", "fd-dialog dev-expanded");
  host.before(placeholder);
  const nav = el("div", "dev-bar");
  nav.append(button("Close", () => dlg.close()));
  for (const other of document.querySelectorAll<HTMLElement>(".dev-workspace"))
    if (other !== host && !other.closest("[data-wd-off]"))
      nav.append(
        button(other.dataset.title ?? "Ward", () => {
          dlg.close();
          expand(other);
        }),
      );
  dlg.append(nav, host);
  document.body.append(dlg);
  dlg.onclose = () => {
    placeholder.replaceWith(host);
    dlg.remove();
  };
  dlg.showModal();
}
interface State {
  project: string;
  session?: string;
  tabs?: string[];
  active?: string;
}
async function mount(w: WardInstance) {
  const b = body(w.i);
  if (!b || states.has(w.i)) return;
  const host = el("div", "dev-workspace"),
    bar = el("div", "dev-bar"),
    content = el("div", "dev-content");
  host.dataset.kind = w.type;
  host.dataset.title = w.title ?? CATALOG[w.type]!.title;
  host.append(bar, content);
  b.replaceChildren(host);
  let stopped = false;
  const cleanup: (() => void)[] = [];
  states.set(w.i, {
    stop() {
      stopped = true;
      cleanup.forEach((f) => f());
      states.delete(w.i);
    },
  });
  try {
    const projects: Project[] = await api("projects");
    let state: State = await api("view", { id: w.i });
    if (stopped) return;
    state.project ||=
      readPages().find((p) => p.id === pageOfCard(w.i))?.project ??
      projects[0]?.id ??
      "";
    const picker = select("Project", []);
    picker.add(new Option("Select project", ""));
    projects.forEach((p) => picker.add(new Option(p.name, p.id)));
    picker.value = state.project;
    const remember = () => api("view", { id: w.i, value: state }, "POST");
    picker.onchange = async () => {
      state = { project: picker.value };
      await remember();
      states.get(w.i)?.stop();
      void mount(w);
    };
    const projectButton = button("Open / new project", async () => {
      const project = await chooseProject();
      if (!project) return;
      state = { project: project.id };
      await remember();
      states.get(w.i)?.stop();
      await mount(w);
    });
    bar.append(picker, projectButton, button("Expand", () => expand(host)));
    if (!state.project) {
      if (w.type === "terminal" || w.type === "editor") bar.hidden = true;
      const empty = el("div", "dev-empty");
      const mark = el("span", "dev-empty-icon"); mark.append(icon(w.type === "terminal" ? "code" : "folder"));
      empty.append(mark, el("h3", undefined, "Your workspace starts here"),
        el("p", undefined, "Open a folder or create a project to get started. Files and sessions stay on this desktop."));
      empty.append(projectButton);
      content.append(empty);
      return;
    }
    if (w.type === "project-files") {
      const { fileExplorer } = await import("./project-editor.ts");
      const explorer = fileExplorer(content, api, state.project, (path, line) =>
        window.dispatchEvent(new CustomEvent("fd:open-file", { detail: { project: state.project, path, line, page: pageOfCard(w.i) } })));
      cleanup.push(explorer.stop);
    } else if (w.type === "editor") {
      const { projectEditor } = await import("./project-editor.ts");
      if (stopped) return;
      cleanup.push(projectEditor(host, {
        api, owner, project: projects.find(p => p.id === state.project)!, state, remember,
        changeProject: () => projectButton.click(), expand: () => expand(host), page: pageOfCard(w.i),
      }));
    } else if (w.type === "terminal") {
      const caps = await api("capabilities");
      const names = { shell: "Shell", codex: "Codex", claude: "Claude Code" };
      const sessions = select("Terminal session", []);
      const surface = el("div", "term-surface");
      const screen = el("div", "dev-terminal");
      const empty = el("div", "dev-empty term-empty");
      const footer = el("div", "term-footer");
      const status = el("span", "term-status", "Loading sessions…");
      status.setAttribute("role", "status");
      const project = projects.find(p => p.id === state.project)!;
      projectButton.className = "term-project";
      projectButton.replaceChildren(icon("folder"), el("span", undefined, project?.name ?? "Project"));
      projectButton.title = project?.root ?? "Change project";
      projectButton.setAttribute("aria-label", "Change project");
      const toolButton = (id: string, label: string, fn: () => unknown) => {
        const b = button(label, fn);
        b.className = "term-tool";
        b.replaceChildren(icon(id));
        b.title = label;
        b.setAttribute("aria-label", label);
        return b;
      };
      const newButton = toolButton("plus", "New terminal session", () => sessionDialog());
      const more = toolButton("more", "Terminal actions", () => {});
      const expandButton = toolButton("resize", "Expand terminal", () => expand(host));
      expandButton.classList.add("term-expand");
      bar.classList.add("term-toolbar");
      bar.replaceChildren(sessions, newButton, more, expandButton);
      footer.append(projectButton, status);
      surface.append(screen, empty);
      content.replaceChildren(surface, footer);
      const term = new Terminal({
        scrollback: 1000, fontSize: 13, lineHeight: 1.2,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
        theme: { background: "#101419", foreground: "#e4e9f0", cursor: "#c5d6e8" },
        disableStdin: true, screenReaderMode: true,
      });
      const fit = new FitAddon(), search = new SearchAddon();
      term.loadAddon(fit);
      term.loadAddon(search);
      term.open(screen);
      let session: SessionView | undefined, list: SessionView[] = [];
      let sequence: number | undefined, updating: Promise<void> | undefined;
      let inputQueue = Promise.resolve(), connected = false, launching = false;
      let sessionOptions = "", autoAttach = !state.session;
      const uncertain = new Set<string>();
      const canType = () => !!session && connected && session.state === "running" &&
        session.owner === owner && !uncertain.has(session.id);
      const take = button("Take control", async () => {
        const id = state.session;
        if (!id) return;
        await update(); // Reconcile the screen before acknowledging uncertain input.
        if (!connected || state.session !== id) return;
        await api("control", { id, takeover: true }, "POST");
        uncertain.delete(id);
        await update();
        resize();
        term.focus();
      });
      take.className = "term-control";
      const restart = button("Start again", async () => {
        const id = state.session;
        if (id) await launch(undefined, id);
      });
      restart.className = "term-control";
      footer.append(take, restart);
      const keys = el("div", "term-keys");
      let showKeys = matchMedia("(pointer: coarse)").matches;
      for (const [label, data, direction] of [["Esc", "\x1b"], ["Tab", "\t"], ["Left", "\x1b[D", "180deg"],
        ["Down", "\x1b[B", "90deg"], ["Up", "\x1b[A", "-90deg"], ["Right", "\x1b[C", "0deg"], ["Ctrl-C", "\x03"], ["Enter", "\r"]]) {
        const key = button(label!, () => send(data!));
        if (direction) {
          const arrow = el("span"); arrow.style.display = "inline-flex"; arrow.style.rotate = direction;
          arrow.append(icon("right")); key.replaceChildren(arrow); key.setAttribute("aria-label", label!); key.title = label!;
        }
        // A touch key must not dismiss the phone's terminal keyboard.
        key.addEventListener("pointerdown", e => e.preventDefault());
        keys.append(key);
      }
      surface.after(keys);
      function draw() {
        const writable = canType();
        term.options.disableStdin = !writable;
        empty.hidden = !!session || !connected;
        screen.hidden = !session;
        sessions.disabled = !list.length;
        newButton.disabled = launching;
        empty.querySelectorAll<HTMLButtonElement>("button").forEach(b => b.disabled = launching);
        take.hidden = !session || session.state !== "running" || writable;
        take.disabled = !connected;
        take.textContent = session && uncertain.has(session.id) ? "Review & take control" : "Take control";
        restart.hidden = !session || session.state === "running";
        restart.disabled = !connected || launching;
        keys.hidden = !showKeys || !session || session.state !== "running";
        keys.querySelectorAll<HTMLButtonElement>("button").forEach(b => b.disabled = !writable);
        const text = !connected ? "Reconnecting…" : !session ? "Ready" :
          session.state !== "running" ? (session.state === "exited" ? `Exited${session.exitCode === null ? "" : ` · ${session.exitCode}`}` : "Interrupted") :
          uncertain.has(session.id) ? "Input unconfirmed · review the screen" :
          writable ? "You’re in control" : session.owner ? "Viewing · controlled elsewhere" : "Viewing only";
        if (status.textContent !== text) status.textContent = text;
        status.dataset.state = !connected || (session && uncertain.has(session.id)) ? "attention" : writable ? "active" : "idle";
        status.title = session ? `${names[session.kind]} · ${session.mode} permissions${session.nextMode !== session.mode ? ` · ${session.nextMode} on next start` : ""}` : "";
      }
      const resize = () => {
        if (!canType() || !screen.clientWidth || !screen.clientHeight) return;
        const id = state.session;
        const oldCols = term.cols, oldRows = term.rows;
        fit.fit();
        if (oldCols !== term.cols || oldRows !== term.rows)
          void api("resize", { id, cols: term.cols, rows: term.rows }, "POST").catch(() => {});
      };
      function update(): Promise<void> {
        if (updating) return updating;
        if (stopped) return Promise.resolve();
        updating = (async () => {
          try {
            const next: SessionView[] = await api("sessions", { project: state.project });
            if (stopped) return;
            list = next;
            // Don't rebuild the searchable picker on every output poll.
            const signature = JSON.stringify(list.map(s => [s.id, s.title, s.state]));
            if (signature !== sessionOptions) {
              sessionOptions = signature;
              sessions.replaceChildren(new Option(list.length ? "Choose a session" : "Terminal", ""));
              list.forEach(s => sessions.add(new Option(`${s.title === s.kind ? names[s.kind] : s.title}${s.state === "running" ? "" : ` · ${s.state}`}`, s.id)));
            }
            if (autoAttach && list.length) {
              autoAttach = false;
              state.session = (list.find(s => s.state === "running") ?? list[0])!.id;
              await remember();
            }
            sessions.value = state.session ?? "";
            if (state.session) {
              const id = state.session;
              const result = await api("sessions", { id, ...(sequence === undefined ? {} : { after: sequence }) });
              if (stopped || state.session !== id) return;
              session = result.session;
              screen.hidden = false;
              if (session!.cols !== term.cols || session!.rows !== term.rows) term.resize(session!.cols, session!.rows);
              if (result.reset) term.reset();
              if (result.data) await new Promise<void>(resolve => term.write(result.data, resolve));
              sequence = session!.sequence;
            }
            connected = true;
          } catch {
            connected = false;
            if (state.session) uncertain.add(state.session);
          } finally {
            if (!stopped) draw();
          }
        })().finally(() => { updating = undefined; });
        return updating;
      }
      async function attach(id: string) {
        await update();
        if (stopped) return;
        autoAttach = false;
        state.session = id;
        session = undefined;
        sequence = undefined;
        term.reset();
        await remember();
        await update();
      }
      async function launch(options?: Record<string, unknown>, previous?: string) {
        if (launching) return;
        launching = true;
        draw();
        try {
          const s: SessionView = previous ? await api("restart", { id: previous }, "POST") :
            await api("sessions", { project: state.project, kind: "shell", mode: "human", ...options }, "POST");
          await attach(s.id);
          // This action created the session for this human; make it ready to type.
          await api("control", { id: s.id, takeover: true }, "POST");
          await update();
          resize();
          term.focus();
        } finally {
          launching = false;
          if (!stopped) draw();
        }
      }
      const send = async (data: string) => {
        const id = state.session;
        inputQueue = inputQueue.catch(() => {}).then(async () => {
          if (!id || state.session !== id || !canType()) return;
          try { await api("input", { id, data }, "POST"); }
          catch (e) {
            uncertain.add(id);
            draw();
            toast((e as Error).message, undefined, true);
          }
        });
        await inputQueue;
      };
      const listener = term.onData(data => void send(data));
      sessions.onchange = () => void attach(sessions.value).catch(e => toast(e.message, undefined, true));
      const start = button("Open terminal", () => launch());
      start.className = "btn-primary";
      const agentChoices = el("div", "term-agent-choices");
      agentChoices.append(button("Codex", () => sessionDialog(undefined, "codex")), button("Claude Code", () => sessionDialog(undefined, "claude")));
      const mark = el("span", "dev-empty-icon"); mark.append(icon("code"));
      empty.append(mark, el("h3", undefined, "A terminal for your project"),
        el("p", undefined, "Open a shell, or work with a terminal agent."), start, agentChoices);

      function sessionDialog(existing?: SessionView, initial: TerminalKind = "shell") {
        const { d, form, actions, error, submit } = workspaceDialog(existing ? "Session settings" : "New terminal session");
        d.classList.add("term-session-dialog");
        const field = (label: string, control: HTMLElement) => {
          const row = el("label", undefined, label);
          row.append(control);
          return row;
        };
        const program = select("Program", []);
        for (const [value, name] of Object.entries(names)) program.add(new Option(name, value));
        program.value = initial;
        const shell = select("Shell", [...new Set<string>(caps.shells)]);
        const mode = select("Permission mode", []);
        mode.add(new Option("Human — I answer permission prompts", "human"));
        mode.add(new Option("Rimeward — delegate prompt decisions", "rimeward"));
        mode.add(new Option("YOLO — bypass permission prompts", "yolo"));
        mode.value = existing?.nextMode ?? "human";
        const task = el("textarea", "input");
        task.rows = 3; task.maxLength = 8000;
        task.placeholder = "What would you like the agent to work on?";
        const taskField = field("Initial task (optional)", task);
        const options = el("details", "term-launch-options");
        const shellField = field("Shell", shell);
        options.append(el("summary", undefined, "More options"), shellField, field("Permissions", mode));
        const modeHelp = el("p", "term-help");
        const describeMode = () => {
          modeHelp.textContent = mode.value === "human" ? "Permission prompts stay in the terminal for you to answer." :
            mode.value === "rimeward" ? "Rimeward may answer native permission prompts under your delegated authority." :
            "The agent starts with its explicit permission bypass enabled.";
        };
        mode.onchange = describeMode;
        describeMode();
        options.append(modeHelp);
        const availability = el("p", "term-help");
        const syncProgram = () => {
          const kind = program.value as TerminalKind;
          taskField.hidden = kind === "shell";
          shellField.hidden = kind !== "shell";
          const missing = kind !== "shell" && !caps.agents[kind];
          submit.disabled = missing;
          submit.textContent = kind === "shell" ? "Open terminal" : `Start ${names[kind]}`;
          availability.replaceChildren();
          if (kind !== "shell") {
            availability.append(document.createTextNode(missing ? `${names[kind]} isn’t installed on this desktop. ` : "Uses your existing local sign-in. "));
            const link = el("a", "link", "Setup guide ↗");
            link.href = kind === "codex" ? "https://developers.openai.com/codex/cli" : "https://code.claude.com/docs/en/setup";
            link.target = "_blank"; link.rel = "noopener noreferrer";
            availability.append(link);
          }
        };
        if (existing) {
          options.open = true;
          shellField.hidden = true;
          actions.before(el("p", "term-help", `${existing.title} · ${names[existing.kind]}. Permission changes apply on the next start; this process keeps running.`), options);
          submit.textContent = "Save for next start";
        } else {
          actions.before(field("Program", program), taskField, availability, options);
          program.onchange = syncProgram;
          syncProgram();
        }
        form.onsubmit = async e => {
          e.preventDefault();
          submit.disabled = true;
          error.hidden = true;
          try {
            if (existing) {
              await api("configure", { id: existing.id, mode: mode.value }, "POST");
              await update();
            } else {
              const kind = program.value as TerminalKind;
              await launch({ kind, mode: mode.value, ...(kind === "shell" ? { shell: shell.value } : { task: task.value }),
                title: `${names[kind]} ${list.filter(s => s.kind === kind).length + 1}` });
            }
            d.close();
          } catch (e) {
            error.textContent = (e as Error).message;
            error.hidden = false;
          } finally { submit.disabled = false; }
        };
        d.onclose = () => { d.remove(); if (canType()) term.focus(); };
      }

      const findBar = el("div", "term-find");
      findBar.hidden = true;
      const query = input("Find in terminal"), result = el("span", "term-find-result");
      result.setAttribute("role", "status");
      const find = (previous = false) => {
        const found = !query.value || (previous ? search.findPrevious(query.value) : search.findNext(query.value));
        result.textContent = found ? "" : "No match";
      };
      const closeFind = () => { findBar.hidden = true; search.clearDecorations(); term.focus(); };
      findBar.append(query, result, toolButton("left", "Previous match", () => find(true)),
        toolButton("right", "Next match", () => find()), toolButton("close", "Close search", closeFind));
      surface.prepend(findBar);
      const openFind = () => { findBar.hidden = false; query.focus(); query.select(); };
      query.oninput = () => find();
      query.onkeydown = e => {
        if (e.isComposing) return;
        if (e.key === "Enter") { e.preventDefault(); find(e.shiftKey); }
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeFind(); }
      };
      term.attachCustomKeyEventHandler(e => {
        // Keep Ctrl+F available to shells and interactive terminal applications.
        if ((e.metaKey || (e.ctrlKey && e.shiftKey)) && e.key.toLowerCase() === "f") {
          if (e.type === "keydown") { e.preventDefault(); openFind(); }
          return false;
        }
        return true;
      });
      // Native popovers stay above ward clipping and the expanded dialog, and
      // provide outside-click/Escape dismissal without document listeners.
      const menu = el("div", "term-menu");
      menu.popover = "auto";
      menu.setAttribute("role", "menu");
      menu.setAttribute("aria-label", "Terminal actions");
      more.popoverTargetElement = menu;
      more.setAttribute("aria-haspopup", "menu");
      more.setAttribute("aria-expanded", "false");
      host.append(menu);
      menu.addEventListener("beforetoggle", e => {
        if ((e as ToggleEvent).newState !== "open") return;
        menu.replaceChildren();
        const action = (label: string, fn: () => unknown, disabled = false, danger = false) => {
          const b = button(label, async () => { menu.hidePopover(); await fn(); });
          b.className = "term-menu-item";
          b.setAttribute("role", "menuitem");
          b.disabled = disabled;
          if (danger) b.dataset.danger = "true";
          menu.append(b);
        };
        action("Find in terminal…", openFind, !session);
        action("Copy selection", () => navigator.clipboard.writeText(term.getSelection()), !term.hasSelection());
        action(showKeys ? "Hide extra keys" : "Show extra keys", () => { showKeys = !showKeys; draw(); });
        if (session) {
          const target = session;
          menu.append(el("hr"));
          action("Session settings…", () => sessionDialog(target));
          if (target.state === "running") {
            action("Release input control", async () => { await api("release", { id: target.id }, "POST"); await update(); }, !canType());
            action("Interrupt process", () => api("interrupt", { id: target.id }, "POST"), !canType());
            menu.append(el("hr"));
            action("End session…", async () => {
              if (await confirmAction(`End ${target.title}? The process will stop. Its saved screen stays available.`)) {
                await api("sessions", { id: target.id }, "DELETE");
                await update();
              }
            }, !connected, true);
          }
        }
      });
      menu.addEventListener("toggle", e => {
        const open = (e as ToggleEvent).newState === "open";
        more.setAttribute("aria-expanded", String(open));
        if (!open) return;
        const anchor = more.getBoundingClientRect(), box = menu.getBoundingClientRect();
        menu.style.left = `${Math.max(8, Math.min(anchor.right - box.width, innerWidth - box.width - 8))}px`;
        menu.style.top = `${anchor.bottom + box.height + 8 < innerHeight ? anchor.bottom + 5 : Math.max(8, anchor.top - box.height - 5)}px`;
        menu.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
      });
      menu.onkeydown = e => {
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
        e.preventDefault();
        const items = [...menu.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
        const at = items.indexOf(document.activeElement as HTMLButtonElement);
        items[e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 :
          (at + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
      };
      const ro = new ResizeObserver(resize);
      ro.observe(screen);
      cleanup.push(
        poll(async () => {
          await update();
          if (canType()) await api("control", { id: state.session }, "POST").catch(() => {});
        }, 750),
        () => {
          if (menu.matches(":popover-open")) menu.hidePopover();
          ro.disconnect(); listener.dispose(); term.dispose();
        },
      );
      await update();
    } else {
      const output = el("pre", "dev-diff");
      content.append(output);
      const refresh = async () => {
        const g = await api("git", { project: state.project });
        output.textContent = g.status + "\n" + g.diff + "\n" + g.worktrees;
      };
      bar.append(
        button("Refresh", refresh),
        button("New worktree", async () => {
          const name = await askText("Worktree name");
          if (name) {
            await api(
              "worktree",
              { project: state.project, name, op: "add" },
              "POST",
            );
            await refresh();
          }
        }),
        button("Remove worktree", async () => {
          const name = await askText(
            "Rimeward worktree name (dirty trees are preserved)",
          );
          if (name) {
            await api(
              "worktree",
              { project: state.project, name, op: "remove" },
              "POST",
            );
            await refresh();
          }
        }),
      );
      cleanup.push(
        poll(
          () =>
            refresh().catch((e) => {
              output.textContent = e.message;
            }),
          5000,
        ),
      );
    }
  } catch (err) {
    content.textContent = (err as Error).message;
  }
}
for (const type of DEV_WARDS)
  RENDERERS[type] = {
    render: mount,
    stop(id) {
      states.get(id)?.stop();
    },
  };
