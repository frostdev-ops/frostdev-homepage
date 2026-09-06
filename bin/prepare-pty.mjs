// node-pty 1.1.0 ships its macOS prebuilt spawn-helper without executable mode.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const root = path.dirname(require.resolve("node-pty/package.json"));
for (const relative of [
  "build/Release/spawn-helper",
  `prebuilds/${process.platform}-${process.arch}/spawn-helper`,
]) {
  const helper = path.join(root, relative);
  if (process.platform !== "win32" && fs.existsSync(helper))
    fs.chmodSync(helper, 0o755);
}
