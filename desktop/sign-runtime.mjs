// Sign nested native resources before Tauri seals and notarizes the outer app.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const desktop = path.dirname(fileURLToPath(import.meta.url));
const root = process.argv[2] ?? path.join(desktop, "runtime");
const identity = process.env.APPLE_SIGNING_IDENTITY;
if (process.platform !== "darwin" || !identity)
  throw new Error("macOS and APPLE_SIGNING_IDENTITY are required.");

const files = [], bundles = [];
function scan(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      scan(file);
      if (/\.(app|framework|xpc)$/.test(entry.name)) bundles.push(file);
    } else if (entry.isFile()) {
      const fd = fs.openSync(file, "r"), header = Buffer.alloc(4);
      try {
        if (fs.readSync(fd, header, 0, 4, 0) === 4 &&
            [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca].includes(header.readUInt32BE())) {
          // `file` distinguishes universal Mach-O from Java's shared magic value.
          if (execFileSync("file", ["-b", file], { encoding: "utf8" }).includes("Mach-O")) files.push(file);
        }
      } finally { fs.closeSync(fd); }
    }
  }
}
// Build artifacts can acquire Finder metadata after extraction on macOS.
execFileSync("xattr", ["-cr", root], { stdio: "pipe" });
scan(root);
if (!files.length) throw new Error("No Mach-O runtime binaries found.");
const options = ["--force", "--sign", identity, "--options", "runtime",
  "--entitlements", path.join(desktop, "entitlements.plist"),
  ...(identity === "-" ? ["--timestamp=none"] : ["--timestamp"]),
  ...(process.env.RIMEWARD_SIGNING_KEYCHAIN ? ["--keychain", process.env.RIMEWARD_SIGNING_KEYCHAIN] : [])];
// Sign individual code first, then bundles from the inside out. Never --deep sign.
for (const file of [...files, ...bundles]) execFileSync("codesign", [...options, file], { stdio: "pipe" });
for (const file of [...files, ...bundles]) execFileSync("codesign", ["--verify", "--strict", file], { stdio: "pipe" });
console.log(`Signed and verified ${files.length} native binaries and ${bundles.length} bundles.`);
