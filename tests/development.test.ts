import "./_setup.ts";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEV_TOOLS } from "../src/lib/dev/tools.ts";
import {
  addProject,
  projectPath,
  readBuffer,
  readPage,
  gitView,
  DIFF_CAP,
  editBuffer,
  bufferCopies,
  renameFile,
  createProject,
  worktreeOp,
  git,
} from "../src/lib/dev/projects.ts";
import {
  terminalEnv,
  cliArgs,
  startSession,
  writeSession,
  waitSession,
  readSession,
  closeSession,
  controlSession,
  releaseControl,
} from "../src/lib/dev/terminals.ts";
process.env.RIMEWARD_DESKTOP = "1";
process.env.RIMEWARD_NATIVE_TOKEN = "test-only";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "rimeward-project-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));
test("approved roots, independent user ownership, versioned recovery, conflicts and encoding", () => {
  const p = addProject(1, root);
  const file = path.join(root, "a.txt");
  fs.writeFileSync(file, Buffer.from("\ufeffone\r\ntwo\r\n"));
  assert.throws(() => projectPath(2, p.id, "a.txt"));
  assert.throws(() => projectPath(1, p.id, "../escape"));
  fs.symlinkSync(os.tmpdir(), path.join(root, "outside"), "dir");
  assert.throws(() => projectPath(1, p.id, "outside"));
  const initial = readBuffer(1, p.id, "a.txt");
  assert.equal(initial.text, "one\ntwo\n");
  const dirty = editBuffer(1, p.id, "a.txt", "client:one", {
    text: "edited\n",
    revision: initial.revision,
  });
  assert.equal(fs.readFileSync(file, "utf8"), "\ufeffone\r\ntwo\r\n");
  assert.throws(() =>
    editBuffer(1, p.id, "a.txt", "client:two", { text: "lost" }),
  );
  assert.throws(() =>
    editBuffer(1, p.id, "a.txt", "client:one", {
      text: "stale",
      revision: initial.revision,
    }),
  );
  fs.writeFileSync(file, "external\r\n");
  assert.equal(readBuffer(1, p.id, "a.txt").conflict, true);
  assert.throws(() =>
    editBuffer(1, p.id, "a.txt", "client:one", {
      save: true,
      revision: dirty.revision,
    }),
  );
  editBuffer(1, p.id, "a.txt", "client:one", {
    resolve: "mine",
    revision: dirty.revision,
  });
  assert.equal(fs.readFileSync(file, "utf8"), "\ufeffedited\r\n");
  assert.equal((bufferCopies(1, p.id, "a.txt")[0] as any).text, "external\n");
  editBuffer(1, p.id, "a.txt", "client:one", {
    text: "recover deleted",
    revision: readBuffer(1, p.id, "a.txt").revision,
  });
  fs.unlinkSync(file);
  assert.equal(readBuffer(1, p.id, "a.txt").text, "recover deleted");
  editBuffer(1, p.id, "a.txt", "client:one", { resolve: "mine" });
  assert.equal(fs.readFileSync(file, "utf8"), "\ufeffrecover deleted");
});
test("PTY environment excludes backend credentials and permission flags are explicit", () => {
  const env = terminalEnv({
    PATH: "/bin",
    HOME: "/tmp",
    TOKEN_ENC_KEY: "secret",
    OPENAI_API_KEY: "secret",
    RIMEWARD_NATIVE_TOKEN: "secret",
    SECRET_BACKEND_KEY: "secret",
  });
  assert.equal(env.TOKEN_ENC_KEY, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.SECRET_BACKEND_KEY, undefined);
  assert.deepEqual(cliArgs("codex", "human"), [
    "--ask-for-approval",
    "on-request",
    "--sandbox",
    "workspace-write",
  ]);
  assert.ok(
    cliArgs("codex", "yolo").includes(
      "--dangerously-bypass-approvals-and-sandbox",
    ),
  );
  assert.ok(
    cliArgs("claude", "yolo").includes("--dangerously-skip-permissions"),
  );
});
test("real terminal attachment, no replay, human control and explicit termination", async () => {
  const p = addProject(1, root);
  const s = await startSession(1, {
    project: p.id,
    kind: "shell",
    mode: "rimeward",
  });
  try {
    controlSession(1, s.id, "client:one", true);
    writeSession(1, s.id, "client:one", "echo RIMEWARD_PTY_TEST\r");
    const until = Date.now() + 5000;
    while (
      Date.now() < until &&
      !readSession(1, s.id).screen.includes("RIMEWARD_PTY_TEST")
    )
      await waitSession(1, s.id, readSession(1, s.id).session.sequence, 500);
    const result = readSession(1, s.id);
    assert.match(result.screen, /RIMEWARD_PTY_TEST/);
    assert.equal(readSession(1, s.id, result.session.sequence).data, "");
    assert.throws(() => writeSession(1, s.id, "agent:rime", "echo denied\r"));
    releaseControl(1, s.id, "client:one");
    writeSession(1, s.id, "agent:rime", "echo resumed\r");
    assert.throws(() => readSession(2, s.id));
  } finally {
    closeSession(1, s.id);
  }
});

test("worktrees preserve disk changes, dirty recovery buffers, and unrelated shared-tree changes", async () => {
  const p = addProject(1, root);
  await git(1, p.id, ["init", "-b", "main"]);
  await git(1, p.id, ["add", "a.txt"]);
  await git(1, p.id, [
    "-c",
    "user.name=Rimeward Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-m",
    "fixture",
  ]);
  const w = await worktreeOp(1, p.id, "add", "safe-removal");
  assert.ok("root" in w);
  if (!("root" in w)) return;
  const text = readBuffer(1, w.id, "a.txt");
  editBuffer(1, w.id, "a.txt", "client:worktree", {
    text: "unsaved",
    revision: text.revision,
  });
  await assert.rejects(() => worktreeOp(1, p.id, "remove", "safe-removal"));
  assert.ok(fs.existsSync(w.root));
  editBuffer(1, w.id, "a.txt", "client:worktree", { resolve: "disk" });
  fs.writeFileSync(path.join(w.root, "untracked"), "keep");
  await assert.rejects(() => worktreeOp(1, p.id, "remove", "safe-removal"));
  assert.equal(fs.readFileSync(path.join(w.root, "untracked"), "utf8"), "keep");
  fs.unlinkSync(path.join(w.root, "untracked"));
  await worktreeOp(1, p.id, "remove", "safe-removal");
});

test("legacy newlines and large external replacements retain recoverable text", () => {
  const p = addProject(1, root);
  fs.writeFileSync(path.join(root, "cr.txt"), "one\rtwo\r");
  const cr = readBuffer(1, p.id, "cr.txt");
  editBuffer(1, p.id, "cr.txt", "client:encoding", {
    text: "changed\n",
    revision: cr.revision,
    save: true,
  });
  assert.equal(fs.readFileSync(path.join(root, "cr.txt"), "utf8"), "changed\r");
  fs.writeFileSync(path.join(root, "odd.txt"), Buffer.from([255, 254, 65]));
  assert.equal(readBuffer(1, p.id, "odd.txt").readonly, true);
  fs.writeFileSync(path.join(root, "growing.txt"), "small");
  const v = readBuffer(1, p.id, "growing.txt");
  editBuffer(1, p.id, "growing.txt", "client:encoding", {
    text: "keep my draft",
    revision: v.revision,
  });
  fs.writeFileSync(
    path.join(root, "growing.txt"),
    Buffer.alloc(5 * 1024 * 1024 + 1, 65),
  );
  const conflict = readBuffer(1, p.id, "growing.txt");
  assert.equal(conflict.text, "keep my draft");
  assert.equal(conflict.readonly, true);
  assert.equal(conflict.conflict, true);
});

test("symlink aliases share buffers and renaming a link preserves its target", () => {
  const p = addProject(1, root);
  fs.writeFileSync(path.join(root, "target.txt"), "target");
  fs.symlinkSync(
    path.join(root, "target.txt"),
    path.join(root, "alias.txt"),
    "file",
  );
  const alias = readBuffer(1, p.id, "alias.txt");
  assert.equal(alias.path, "target.txt");
  renameFile(1, p.id, "alias.txt", "renamed-link.txt");
  assert.equal(
    fs.readFileSync(path.join(root, "target.txt"), "utf8"),
    "target",
  );
  assert.ok(fs.lstatSync(path.join(root, "renamed-link.txt")).isSymbolicLink());
  fs.mkdirSync(path.join(root, "removed-dir"));
  fs.writeFileSync(path.join(root, "removed-dir", "file.txt"), "old");
  const v = readBuffer(1, p.id, "removed-dir/file.txt");
  editBuffer(1, p.id, "removed-dir/file.txt", "client:recovery", {
    text: "recover directory",
    revision: v.revision,
  });
  fs.rmSync(path.join(root, "removed-dir"), { recursive: true });
  assert.equal(
    readBuffer(1, p.id, "removed-dir/file.txt").text,
    "recover directory",
  );
});

test("new projects create a folder without replacing existing or private data", () => {
  const p = createProject(1, root, "new-project");
  assert.equal(fs.statSync(p.root).isDirectory(), true);
  assert.throws(() => createProject(1, root, "new-project"));
  assert.throws(() => createProject(1, root, "../escape"));
  assert.throws(() =>
    createProject(1, process.env.HOMEPAGE_DATA_DIR!, "private"),
  );
  assert.equal(
    fs.existsSync(path.join(process.env.HOMEPAGE_DATA_DIR!, "private")),
    false,
  );
});

// Firsthand friction from the agent's own review of this repo: README, AGENTS.md
// and the git diff all came back "result too large" — file and git reads had no
// way to ask for less. A read is a page now, and a diff can be scoped.
test("file reads page under the tool cap and the diff scopes to a path", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rimeward-pages-"));
  after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const p = addProject(1, dir);
  const lines = Array.from({ length: 3000 }, (_, i) => `line ${i + 1} ${"x".repeat(40)}`);
  fs.writeFileSync(path.join(dir, "big.txt"), lines.join("\n") + "\n");
  fs.writeFileSync(path.join(dir, "small.txt"), "hello\n");
  const first = readPage(1, p.id, "big.txt");
  assert.equal(first.from, 1);
  assert.equal(first.lines, 3001);
  assert.ok(first.to < 3001 && first.next === first.to + 1);
  assert.ok(first.text.length <= 10_000);
  assert.ok(first.text.startsWith("line 1 "));
  const second = readPage(1, p.id, "big.txt", first.next, 5);
  assert.equal(second.from, first.next);
  assert.equal(second.to, first.next! + 4);
  assert.equal(second.text.split("\n").length, 5);
  assert.equal(second.revision, first.revision, "a page carries the buffer's revision for the edit that follows");
  assert.equal(readPage(1, p.id, "small.txt").next, undefined);
  const edit = (file: string, revision: number) => DEV_TOOLS.project_edit!.run({ runtime: 'desktop', project: p.id, path: file, text: 'created by Rime\n', revision, save: true }, { userId: 1, ward: 'rime', conv: 0 });
  await edit('created.txt', 0);
  assert.equal(fs.readFileSync(path.join(dir, 'created.txt'), 'utf8'), 'created by Rime\n');
  assert.throws(() => edit('small.txt', 0), { status: 409 });
  assert.equal(fs.readFileSync(path.join(dir, 'small.txt'), 'utf8'), 'hello\n');

  const longLine = '\u0000'.repeat(5000) + 'tail';
  fs.writeFileSync(path.join(dir, "long.json"), JSON.stringify(longLine));
  let cursor: number | undefined, column = 0, recovered = '';
  do {
    const page = readPage(1, p.id, "long.json", cursor, undefined, column);
    assert.ok(JSON.stringify(page).length < 12_000);
    recovered += page.text;
    cursor = page.next; column = page.nextColumn ?? 0;
  } while (cursor !== undefined);
  assert.equal(recovered, JSON.stringify(longLine), "a long escaped line remains fully readable");


  await git(1, p.id, ["init", "-q", "-b", "main"]);
  await git(1, p.id, ["add", "big.txt"]);
  await git(1, p.id, ["-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-q", "-m", "big"]);
  fs.writeFileSync(path.join(dir, "big.txt"), lines.map((l) => l + "!").join("\n") + "\n");
  await git(1, p.id, ["add", "small.txt"]);
  assert.ok((await gitView(1, p.id)).diff.length > DIFF_CAP, "the Changes ward still receives the full diff");
  const all = await gitView(1, p.id, undefined, DIFF_CAP);
  assert.equal(all.truncated, true);
  assert.ok(all.diff.length <= DIFF_CAP);
  assert.ok(JSON.stringify(all).length < 12_000);
  assert.match(all.status, /big\.txt/);
  const scoped = await gitView(1, p.id, "small.txt");
  assert.equal(scoped.truncated, undefined);
  assert.match(scoped.diff, /\+hello/);
  assert.doesNotMatch(scoped.diff, /big\.txt/);
  await assert.rejects(gitView(1, p.id, "../escape"));
});
