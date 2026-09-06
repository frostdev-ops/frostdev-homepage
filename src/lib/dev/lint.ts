import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { DATA_DIR } from "../db.ts";
import { DevError, requireDesktop } from "./runtime.ts";
import { projectPath } from "./projects.ts";
import { terminalEnv } from "./environment.ts";

const require = createRequire(import.meta.url);
const extensions = new Set(["js", "jsx", "mjs", "cjs", "ts", "tsx", "mts", "cts", "json", "jsonc", "css", "graphql", "gql", "html"]);
let running = 0;
export async function analyzeFile(user: number, project: string, file: string, text: unknown, format = false) {
  requireDesktop();
  projectPath(user, project, file, true);
  if (typeof text !== "string" || Buffer.byteLength(text) > 1024 * 1024)
    throw new DevError("Live analysis supports files up to 1 MiB.");
  const ext = file.split(".").at(-1)!.toLowerCase();
  if (!extensions.has(ext)) return { supported: false, diagnostics: [] };
  if (running >= 2) throw new DevError("Analysis is busy. Try again shortly.", 429);
  running++;
  let folder: string | undefined;
  try {
    const base = path.join(DATA_DIR, "analysis");
    await fs.mkdir(base, { recursive: true, mode: 0o700 });
    folder = await fs.mkdtemp(path.join(base, "buffer-"));
    // Only this desktop receives the temporary buffer. Never load project scripts,
    // plugins, or an ancestor config; analysis cannot change the working file.
    await fs.writeFile(path.join(folder, "biome.json"), JSON.stringify({
      root: true, vcs: { enabled: false },
      linter: { enabled: true, rules: { recommended: true } },
      formatter: { indentStyle: "space", indentWidth: 2 },
    }), { mode: 0o600 });
    const name = "buffer." + ext;
    await fs.writeFile(path.join(folder, name), text, { mode: 0o600 });
    const packageName = `@biomejs/cli-${process.platform}-${process.arch}`;
    let binary: string;
    try { binary = require.resolve(packageName + (process.platform === "win32" ? "/biome.exe" : "/biome")); }
    catch { binary = require.resolve(packageName + "-musl/biome"); }
    const args = format ? ["format", "--write", name] : ["lint", "--reporter=json", "--max-diagnostics=100", name];
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(binary, args, { cwd: folder, env: { ...terminalEnv(), BIOME_THREADS: "2" }, timeout: 10_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true }, (err, out) => {
        // A lint error is a successful analysis. Process failures are not.
        if (err && (format || err.killed || !out.trim().startsWith("{"))) reject(new DevError(format ? "Formatting failed. Resolve syntax errors first." : "Code analysis could not finish."));
        else resolve(out);
      });
    });
    if (format) return { supported: true, text: (await fs.readFile(path.join(folder, name), "utf8")).replace(/\r\n?/g, "\n") };
    // Biome's pinned JSON reporter uses 1-based line/column positions.
    const report = JSON.parse(stdout);
    const lines = text.split("\n"), starts = [0];
    for (let i = 0; i < lines.length - 1; i++) starts.push(starts[i]! + lines[i]!.length + 1);
    const offset = (loc?: { line: number; column: number }) => {
      const line = Math.max(0, Math.min(lines.length - 1, (loc?.line ?? 1) - 1));
      // Reporter columns count Unicode scalar values; CodeMirror uses UTF-16.
      const prefix = [...lines[line]!].slice(0, Math.max(0, (loc?.column ?? 1) - 1)).join("");
      return Math.min(starts[line]! + prefix.length, starts[line]! + lines[line]!.length);
    };
    return { supported: true, diagnostics: report.diagnostics.slice(0, 100).map((d: any) => ({
      from: offset(d.location?.start), to: offset(d.location?.end),
      severity: d.severity === "warning" ? "warning" : d.severity === "error" || d.severity === "fatal" ? "error" : "info",
      message: String(d.message), source: "Biome", code: String(d.category ?? ""),
    })), truncated: report.summary?.diagnosticsNotPrinted > 0 };
  } finally {
    try { if (folder) await fs.rm(folder, { recursive: true, force: true }); }
    finally { running--; }
  }
}
