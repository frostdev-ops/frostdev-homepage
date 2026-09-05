// The server this build of Rimeward opens. Two files hard-code it — the window
// URL and the remote capability that lets that page call the app — and both
// are compiled in, so it is a build-time value: RIMEWARD_ORIGIN, default the
// upstream instance. Run from desktop/ (the npm scripts and the release
// workflow do); textual edits, so the files keep their formatting and a run
// with the same origin is a no-op.
import fs from 'node:fs';

const origin = new URL(process.env.RIMEWARD_ORIGIN ?? 'https://frostdev.io').origin;

const swap = (file, pairs) => {
  let text = fs.readFileSync(file, 'utf8');
  for (const [re, to] of pairs) {
    if (!re.test(text)) throw new Error(`${file}: expected ${re}`);
    text = text.replace(re, to);
  }
  fs.writeFileSync(file, text);
};

swap('tauri.conf.json', [
  [/("frontendDist": ")[^"]*(\/dash")/, `$1${origin}$2`],
  [/("url": ")[^"]*(\/dash")/, `$1${origin}$2`],
]);
swap('capabilities/remote.json', [[/("urls": \[")[^"]*(\/\*")/, `$1${origin}$2`]]);
console.log(`Rimeward opens ${origin}/dash`);
