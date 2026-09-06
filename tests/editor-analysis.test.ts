import "./_setup.ts";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { analyzeFile } from "../src/lib/dev/lint.ts";
import { addProject, readBuffer, keepBufferCopy, bufferCopies } from "../src/lib/dev/projects.ts";
import { DATA_DIR } from "../src/lib/db.ts";
process.env.RIMEWARD_DESKTOP = "1";
process.env.RIMEWARD_NATIVE_TOKEN = "test-only";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "rimeward-editor-test-"));
const project = addProject(1, root);
after(() => fs.rmSync(root, { recursive: true, force: true }));
test("bundled Biome diagnoses real source with Unicode ranges without changing files or loading project config", async () => {
  const original = "export const original = 1;\r\n";
  fs.writeFileSync(path.join(root, "file.ts"), original);
  fs.writeFileSync(path.join(root, "biome.json"), '{"root":true,"linter":{"enabled":false}}');
  const text = 'console.log("😀é"); const unused: any = 1;\n';
  const result = await analyzeFile(1, project.id, "file.ts", text);
  assert.equal(result.supported, true);
  for (const [code, expected] of [["noUnusedVariables", "unused"], ["noExplicitAny", "any"]]) {
    const d = result.diagnostics!.find((d: any) => d.code.endsWith(code));
    assert.ok(d); assert.equal(text.slice(d.from, d.to), expected);
  }
  assert.equal(fs.readFileSync(path.join(root, "file.ts"), "utf8"), original);
  for (const [name, text] of [["file.json", '{"a":1,"a":2}'], ["file.css", 'a { color: red; color: blue; }'], ["file.js", 'const x = ;']]) {
    const r = await analyzeFile(1, project.id, name, text);
    assert.ok(r.diagnostics!.length > 0, name + " uses Biome diagnostics");
  }
  assert.deepEqual(fs.readdirSync(path.join(DATA_DIR, "analysis")), []);
});
test("formatting stays an unsaved edit and unsupported languages are reported honestly", async () => {
  const r = await analyzeFile(1, project.id, "file.ts", "export function answer( ){return 42}", true);
  assert.equal(r.text, "export function answer() {\n  return 42;\n}\n");
  assert.match(fs.readFileSync(path.join(root, "file.ts"), "utf8"), /original/);
  await assert.rejects(analyzeFile(1, project.id, "file.ts", "const x = ;", true), /Formatting failed/);
  assert.equal((await analyzeFile(1, project.id, "file.py", "x = 1")).supported, false);
  assert.deepEqual(fs.readdirSync(path.join(DATA_DIR, "analysis")), []);
});
test("analysis and recovery copies enforce desktop ownership, bounds, and approved paths", async () => {
  await assert.rejects(analyzeFile(2, project.id, "file.ts", "text"));
  await assert.rejects(analyzeFile(1, project.id, "../outside.ts", "text"));
  await assert.rejects(analyzeFile(1, project.id, "file.ts", "x".repeat(1024 * 1024 + 1)));
  fs.symlinkSync(os.tmpdir(), path.join(root, "outside"), "dir");
  await assert.rejects(analyzeFile(1, project.id, "outside/file.ts", "text"));
  const buffer = readBuffer(1, project.id, "file.ts");
  keepBufferCopy(1, project.id, "file.ts", "unacknowledged draft");
  assert.equal((bufferCopies(1, project.id, "file.ts")[0] as {text: string}).text, "unacknowledged draft");
  assert.equal(readBuffer(1, project.id, "file.ts").revision, buffer.revision);
  assert.throws(() => keepBufferCopy(2, project.id, "file.ts", "bad"));
  process.env.RIMEWARD_DESKTOP = "0";
  try { await assert.rejects(analyzeFile(1, project.id, "file.ts", "text"), /connected desktop/); }
  finally { process.env.RIMEWARD_DESKTOP = "1"; }
});
