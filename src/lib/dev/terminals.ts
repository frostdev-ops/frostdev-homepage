import { terminalEnv } from "./environment.ts";
export { terminalEnv } from "./environment.ts";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import type { IPty } from "node-pty";
import type { Terminal as Headless } from "@xterm/headless";
import type { SerializeAddon } from "@xterm/addon-serialize";
import {
  workDb,
  requireDesktop,
  DevError,
  emitDev,
  claimLease,
  leaseOwner,
  releaseLease,
} from "./runtime.ts";
import { projectOf, projectPath } from "./projects.ts";
import type { SessionView, PermissionMode, TerminalKind } from "./types.ts";

const require = createRequire(import.meta.url);
const MAX_HISTORY = 1024 * 1024;
type Row = {
  id: string;
  user_id: number;
  project: string;
  kind: TerminalKind;
  mode: PermissionMode;
  next_mode: PermissionMode | null;
  shell: string;
  title: string;
  state: SessionView["state"];
  exit_code: number | null;
  snapshot: string;
  task: string;
  assignment: string;
  task_state: SessionView["taskState"];
  cols: number;
  rows: number;
  sequence: number;
};
interface Live {
  pty: IPty;
  term: Headless;
  serializer: SerializeAddon;
  sequence: number;
  chunks: { sequence: number; data: string }[];
  bytes: number;
  flush?: ReturnType<typeof setTimeout>;
  user: number;
  id: string;
}
const live = new Map<string, Live>();
const ownerKey = (id: string) => `terminal:${id}`;
export function executable(name: string): string | null {
  const extensions =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")
      : [""];
  const dirs = terminalEnv().PATH.split(path.delimiter);
  dirs.push(
    path.join(os.homedir(), ".local", "bin"),
    path.join(os.homedir(), ".cargo", "bin"),
  );
  if (process.platform === "darwin")
    dirs.push("/opt/homebrew/bin", "/usr/local/bin");
  for (const dir of dirs)
    for (const ext of ["", ...extensions]) {
      const candidate = path.isAbsolute(name)
        ? name
        : path.join(dir, name + ext.toLowerCase());
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {}
    }
  return null;
}
export function terminalCapabilities() {
  requireDesktop();
  return {
    platform: process.platform,
    agents: { codex: !!executable("codex"), claude: !!executable("claude") },
    shells:
      process.platform === "win32"
        ? ["pwsh", "powershell", "cmd", "wsl"].filter((n) => executable(n))
        : [
            process.env.SHELL || os.userInfo().shell || "/bin/sh",
            ...["bash", "zsh", "fish"].filter((n) => executable(n)),
          ],
  };
}
export function cliArgs(
  kind: TerminalKind,
  mode: PermissionMode,
  task = "",
): string[] {
  if (kind === "shell") return [];
  if (kind === "codex")
    return [
      ...(mode === "yolo"
        ? ["--dangerously-bypass-approvals-and-sandbox"]
        : ["--ask-for-approval", "on-request", "--sandbox", "workspace-write"]),
      ...(task ? [task] : []),
    ];
  return [
    ...(mode === "yolo"
      ? ["--dangerously-skip-permissions"]
      : ["--permission-mode", "default"]),
    ...(task ? [task] : []),
  ];
}
function rowOf(user: number, id: string): Row {
  const row = workDb()
    .prepare("SELECT * FROM terminal_sessions WHERE id=? AND user_id=?")
    .get(id, user) as Row | undefined;
  if (!row) throw new DevError("Terminal not found.", 404);
  return row;
}
function view(r: Row): SessionView {
  return {
    id: r.id,
    project: r.project,
    kind: r.kind,
    mode: r.mode,
    nextMode: r.next_mode ?? r.mode,
    title: r.title,
    state: r.state,
    exitCode: r.exit_code,
    owner: leaseOwner(ownerKey(r.id)),
    cols: r.cols,
    rows: r.rows,
    sequence: live.get(r.id)?.sequence ?? r.sequence,
    task: r.task,
    assignment: r.assignment,
    taskState: r.task_state,
  };
}
export function listSessions(user: number, project?: string): SessionView[] {
  if (project) projectOf(user, project);
  return (
    workDb()
      .prepare(
        "SELECT * FROM terminal_sessions WHERE user_id=? AND (? IS NULL OR project=?) ORDER BY rowid DESC",
      )
      .all(user, project ?? null, project ?? null) as Row[]
  ).map(view);
}
function persist(s: Live) {
  clearTimeout(s.flush);
  s.flush = undefined;
  workDb()
    .prepare(
      "UPDATE terminal_sessions SET snapshot=?,sequence=?,cols=?,rows=? WHERE id=? AND user_id=?",
    )
    .run(
      s.serializer.serialize({ scrollback: 1000 }),
      s.sequence,
      s.term.cols,
      s.term.rows,
      s.id,
      s.user,
    );
}
let cleanupInstalled = false;
export async function startSession(
  user: number,
  opts: {
    project: string;
    kind?: TerminalKind;
    mode?: PermissionMode;
    shell?: string;
    task?: string;
    assignment?: string;
    title?: string;
  },
): Promise<SessionView> {
  requireDesktop();
  const p = projectOf(user, opts.project),
    kind = opts.kind ?? "shell",
    mode = opts.mode ?? "human";
  if (
    !["shell", "codex", "claude"].includes(kind) ||
    !["human", "rimeward", "yolo"].includes(mode)
  )
    throw new DevError("Invalid terminal configuration.");
  if (listSessions(user).filter((s) => s.state === "running").length >= 24)
    throw new DevError(
      "Close a terminal before starting another (24 running).",
      429,
    );
  const shell =
    opts.shell ||
    (process.platform === "win32"
      ? executable("pwsh") || executable("powershell") || "cmd.exe"
      : process.env.SHELL || os.userInfo().shell || "/bin/sh");
  const command = executable(kind === "shell" ? shell : kind);
  if (!command)
    throw new DevError(
      `${kind === "shell" ? shell : kind} is not installed. Install it and sign in locally, then try again.`,
      409,
    );
  const { spawn } = require("node-pty") as typeof import("node-pty");
  const { Terminal } =
    require("@xterm/headless") as typeof import("@xterm/headless");
  const { SerializeAddon } =
    require("@xterm/addon-serialize") as typeof import("@xterm/addon-serialize");
  const id = crypto.randomUUID();
  const term = new Terminal({
    cols: 100,
    rows: 30,
    scrollback: 1000,
    allowProposedApi: true,
  });
  const serializer = new SerializeAddon();
  term.loadAddon(serializer);
  const task = (opts.task ?? "").slice(0, 8000),
    assignment = (opts.assignment ?? "").slice(0, 2000);
  // argv is passed directly to the executable, never concatenated into a shell command.
  let program = command,
    args = cliArgs(kind, mode, task);
  if (kind === "shell" && process.platform !== "win32") args = ["-l"];
  if (kind !== "shell" && process.platform !== "win32") {
    const script = fs.realpathSync(command);
    if (/\.[cm]?js$/.test(script)) {
      program = process.execPath;
      args = [script, ...args];
    }
  }
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(command)) {
    const packageFile =
      kind === "codex"
        ? "@openai/codex/bin/codex.js"
        : kind === "claude"
          ? "@anthropic-ai/claude-code/cli.js"
          : "";
    const script =
      packageFile &&
      path.join(path.dirname(command), "node_modules", packageFile);
    if (!script || !fs.existsSync(script))
      throw new DevError(
        "Choose a native executable or the standard npm-installed CLI. This command shim cannot safely accept task arguments.",
        409,
      );
    program = process.execPath;
    args = [script, ...args];
  }
  const pty = spawn(program, args, {
    name: "xterm-256color",
    cwd: projectPath(user, p.id),
    cols: 100,
    rows: 30,
    env: terminalEnv(),
  });
  try {
    workDb()
      .prepare(
        "INSERT INTO terminal_sessions(id,user_id,project,kind,mode,title,state,task,assignment,shell) VALUES(?,?,?,?,?,?,'running',?,?,?)",
      )
      .run(
        id,
        user,
        p.id,
        kind,
        mode,
        (opts.title || kind).slice(0, 100),
        task,
        assignment,
        kind === "shell" ? shell : "",
      );
  } catch (error) {
    pty.kill();
    term.dispose();
    throw error;
  }
  const s: Live = {
    pty,
    term,
    serializer,
    sequence: 0,
    chunks: [],
    bytes: 0,
    user,
    id,
  };
  live.set(id, s);
  pty.onData((data) => {
    term.write(data, () => {
      const sequence = ++s.sequence;
      s.chunks.push({ sequence, data });
      s.bytes += Buffer.byteLength(data);
      while (s.bytes > MAX_HISTORY && s.chunks.length > 1) {
        const oldest = s.chunks.shift();
        if (oldest) s.bytes -= Buffer.byteLength(oldest.data);
      }
      emitDev(user, "output", id, { sequence, data });
      if (!s.flush) {
        s.flush = setTimeout(() => persist(s), 2000);
        s.flush.unref();
      }
    });
  });
  pty.onExit(({ exitCode }) => {
    term.write("", () => {
      persist(s);
      workDb()
        .prepare(
          "UPDATE terminal_sessions SET state='exited',exit_code=?,task_state=CASE WHEN task_state='active' THEN 'needs-attention' ELSE task_state END WHERE id=?",
        )
        .run(exitCode, id);
      live.delete(id);
      releaseLease(ownerKey(id), leaseOwner(ownerKey(id)) ?? "");
      emitDev(user, "session", id, view(rowOf(user, id)));
      term.dispose();
    });
  });
  if (!cleanupInstalled) {
    cleanupInstalled = true;
    process.once("SIGTERM", shutdownTerminals);
    process.once("SIGINT", shutdownTerminals);
  }
  emitDev(user, "session", id, view(rowOf(user, id)));
  return view(rowOf(user, id));
}
export function readSession(user: number, id: string, after?: number) {
  const row = rowOf(user, id),
    s = live.get(id);
  const screen = s
    ? Array.from(
        { length: s.term.rows },
        (_, i) =>
          s.term.buffer.active
            .getLine(s.term.buffer.active.baseY + i)
            ?.translateToString(true) ?? "",
      ).join("\n")
    : "";
  const incremental =
    s &&
    after !== undefined &&
    after >= (s.chunks[0]?.sequence ?? 1) - 1 &&
    after <= s.sequence;
  return {
    session: view(row),
    screen,
    reset: !incremental,
    data: incremental
      ? s.chunks
          .filter((c) => c.sequence > (after ?? -1))
          .map((c) => c.data)
          .join("")
      : s
        ? s.serializer.serialize({ scrollback: 1000 })
        : row.snapshot,
  };
}
export function controlSession(
  user: number,
  id: string,
  owner: string,
  takeover = false,
) {
  const row = rowOf(user, id);
  if (owner.startsWith("client:") && takeover)
    workDb()
      .prepare("UPDATE terminal_sessions SET human_control=1 WHERE id=?")
      .run(id);
  claimLease(ownerKey(id), owner, takeover);
  emitDev(user, "session", id, view(row));
  return view(row);
}
function running(user: number, id: string): Live {
  rowOf(user, id);
  const s = live.get(id);
  if (!s)
    throw new DevError("This process has ended. Start a new session.", 409);
  return s;
}
export function writeSession(
  user: number,
  id: string,
  owner: string,
  data: string,
) {
  const s = running(user, id),
    row = rowOf(user, id);
  if (Buffer.byteLength(data) > 64 * 1024)
    throw new DevError("Input is too large.");
  claimLease(ownerKey(id), owner);
  // Interactive CLIs expose no reliable universal permission-prompt detector.
  // Human sessions accept human keystrokes only; tools may inspect and interrupt.
  if (owner.startsWith("agent:") && row.mode === "human")
    throw new DevError(
      "Human mode requires the user to send interactive input. Use the session task at launch or ask the user to configure delegated control.",
      409,
    );
  if (
    owner.startsWith("agent:") &&
    (
      workDb()
        .prepare("SELECT human_control FROM terminal_sessions WHERE id=?")
        .get(id) as { human_control: number }
    ).human_control
  )
    throw new DevError(
      "Human takeover paused agent input. Ask the user to release control.",
      409,
    );
  s.pty.write(data);
}
export function resizeSession(
  user: number,
  id: string,
  owner: string,
  cols: number,
  rows: number,
) {
  const s = running(user, id);
  claimLease(ownerKey(id), owner);
  cols = Math.max(20, Math.min(400, Math.floor(cols)));
  rows = Math.max(5, Math.min(150, Math.floor(rows)));
  if (!Number.isFinite(cols) || !Number.isFinite(rows))
    throw new DevError("Invalid terminal dimensions.");
  if (s.term.cols === cols && s.term.rows === rows) return;
  s.pty.resize(cols, rows);
  s.term.resize(cols, rows);
  persist(s);
  emitDev(user, "session", id, view(rowOf(user, id)));
}
export function interruptSession(user: number, id: string, owner: string) {
  const s = running(user, id);
  claimLease(ownerKey(id), owner);
  s.pty.write("\x03");
}
export function closeSession(user: number, id: string) {
  const s = running(user, id);
  persist(s);
  s.pty.kill();
}
export function configureSession(
  user: number,
  id: string,
  opts: {
    mode?: PermissionMode;
    taskState?: SessionView["taskState"];
    assignment?: string;
    review?: string;
  },
) {
  rowOf(user, id);
  if (opts.mode) {
    if (!["human", "rimeward", "yolo"].includes(opts.mode))
      throw new DevError("Invalid permission mode.");
    workDb()
      .prepare("UPDATE terminal_sessions SET next_mode=? WHERE id=?")
      .run(opts.mode, id);
  }
  if (opts.taskState) {
    if (
      !["active", "needs-attention", "done", "cancelled"].includes(
        opts.taskState,
      )
    )
      throw new DevError("Invalid task state.");
    workDb()
      .prepare("UPDATE terminal_sessions SET task_state=? WHERE id=?")
      .run(opts.taskState, id);
  }
  if (opts.assignment !== undefined)
    workDb()
      .prepare("UPDATE terminal_sessions SET assignment=? WHERE id=?")
      .run(opts.assignment.slice(0, 2000), id);
  if (opts.review)
    workDb()
      .prepare("UPDATE terminal_sessions SET review=? WHERE id=?")
      .run(opts.review.slice(0, 8000), id);
  emitDev(user, "session", id, view(rowOf(user, id)));
  return view(rowOf(user, id));
}
export async function waitSession(
  user: number,
  id: string,
  after: number,
  ms = 20_000,
) {
  rowOf(user, id);
  const deadline = Date.now() + Math.min(30_000, Math.max(0, ms));
  while (Date.now() < deadline && live.get(id)?.sequence === after)
    await new Promise((r) => setTimeout(r, 250));
  return readSession(user, id, after);
}
export function shutdownTerminals() {
  for (const s of live.values()) {
    try {
      persist(s);
      s.pty.kill();
    } catch {}
  }
}

export function releaseControl(user: number, id: string, owner: string) {
  rowOf(user, id);
  if (leaseOwner(ownerKey(id)) !== owner)
    throw new DevError("Take control before releasing it.", 409);
  releaseLease(ownerKey(id), owner);
  workDb()
    .prepare("UPDATE terminal_sessions SET human_control=0 WHERE id=?")
    .run(id);
  return view(rowOf(user, id));
}

export function restartSession(user: number, id: string) {
  const row = rowOf(user, id);
  if (row.state === "running")
    throw new DevError(
      "Terminate this process before starting another with its saved settings.",
      409,
    );
  // A new interface, not a replay of an old task or approval response.
  return startSession(user, {
    project: row.project,
    kind: row.kind,
    mode: row.next_mode ?? row.mode,
    shell: row.shell || undefined,
    title: row.title,
  });
}
