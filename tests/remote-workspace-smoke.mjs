// Built-app handoff test: isolated desktop, independent server, HTTPS relay,
// desktop and phone browser clients. No real accounts or model requests.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import readline from "node:readline";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
  runtime = path.join(repo, "desktop/runtime");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "rimeward-handoff-")),
  project = path.join(temporary, "project");
fs.mkdirSync(project);
fs.writeFileSync(path.join(project, "hello.txt"), "hello\n");
execFileSync("git", ["init", project], { stdio: "ignore" });
const marker = "HANDOFF_" + crypto.randomUUID(),
  children = [];
let browser, proxy;
let nativeHandler = async () => {
  throw new Error("Native test adapter not ready");
};
let logs = "";
const connections = new Set();
const key = path.join(temporary, "key.pem"),
  cert = path.join(temporary, "cert.pem");
execFileSync(
  "openssl",
  [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    key,
    "-out",
    cert,
    "-days",
    "1",
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=DNS:localhost,IP:127.0.0.1",
  ],
  { stdio: "ignore" },
);
function child(args, env) {
  const p = spawn(process.execPath, args, {
    cwd: repo,
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.push(p);
  p.stderr.on("data", (d) => {
    logs += d.toString();
  });
  return p;
}
function ready(p, type) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Startup timeout: " + logs.slice(-500))),
      30000,
    );
    readline.createInterface({ input: p.stdout }).on("line", (raw) => {
      try {
        const m = JSON.parse(raw);
        if (m.type === type) {
          clearTimeout(timeout);
          resolve(m);
        }
        if (m.type === "desktop")
          void nativeHandler(m)
            .then((value) =>
              p.stdin.write(JSON.stringify({ id: m.id, value }) + "\n"),
            )
            .catch(() =>
              p.stdin.write(
                JSON.stringify({
                  id: m.id,
                  error: "Test native action failed",
                }) + "\n",
              ),
            );
        if (m.type === "vault")
          p.stdin.write(JSON.stringify({ id: m.id, value: "[]" }) + "\n");
      } catch {}
    });
    p.on("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error("Early runtime exit " + code));
    });
  });
}
try {
  // Seed only the independent server's account; application data remains separate.
  const fixture = path.join(repo, "tests/.handoff-server-fixture.mjs");
  fs.writeFileSync(
    fixture,
    `import { createUser } from '../src/lib/users.ts';import { createSession } from '../src/lib/auth.ts';const user=createUser('test@example.com','test-only-password');const cookie=createSession(user).id;const {httpServer}=await import('../server.mjs');if(!httpServer.listening)await new Promise(r=>httpServer.once('listening',r));console.log(JSON.stringify({type:'server',port:httpServer.address().port,cookie}));`,
  );
  const server = child([fixture], {
    HOMEPAGE_DATA_DIR: path.join(temporary, "server"),
    TOKEN_ENC_KEY: Buffer.alloc(32, 5).toString("base64"),
    PUBLIC_BASE_URL: "",
    HOST: "127.0.0.1",
    PORT: "0",
  });
  const serverInfo = await ready(server, "server");
  fs.rmSync(fixture);
  proxy = https.createServer(
    { key: fs.readFileSync(key), cert: fs.readFileSync(cert) },
    (req, res) => {
      const forward = http.request(
        {
          host: "127.0.0.1",
          port: serverInfo.port,
          path: req.url,
          method: req.method,
          headers: req.headers,
        },
        (up) => {
          res.writeHead(up.statusCode, up.headers);
          up.pipe(res);
        },
      );
      forward.on("error", () => res.destroy());
      req.pipe(forward);
    },
  );
  proxy.on("connection", (s) => {
    connections.add(s);
    s.on("close", () => connections.delete(s));
  });
  proxy.on("upgrade", (req, socket, head) => {
    const upstream = net.connect(serverInfo.port, "127.0.0.1", () => {
      upstream.write(
        `${req.method} ${req.url} HTTP/1.1\r\n${Object.entries(req.headers)
          .map(([k, v]) => k + ": " + v)
          .join("\r\n")}\r\n\r\n`,
      );
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  const origin = "https://localhost:" + proxy.address().port;
  const desktop = child(["desktop-runtime.mjs"], {
    HOMEPAGE_DATA_DIR: path.join(temporary, "desktop"),
    NODE_EXTRA_CA_CERTS: cert,
  });
  const boot = ready(desktop, "ready");
  desktop.stdin.write(
    JSON.stringify({
      key: Buffer.alloc(32, 7).toString("base64"),
      data: path.join(temporary, "desktop"),
      browsers: path.join(runtime, "browsers"),
    }) + "\n",
  );
  const { url } = await boot;
  process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(runtime, "browsers");
  const { chromium } = await import("playwright-core");
  browser = await chromium.launch({
    headless: true,
    channel: "chromium",
    args: ["--disable-gpu"],
  });
  const pc = await browser.newContext({ ignoreHTTPSErrors: true }),
    phone = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      ignoreHTTPSErrors: true,
    });
  const desktopPage = await pc.newPage();
  const errors = [];
  desktopPage.on("pageerror", (e) => errors.push(e.message));
  let verificationUrl = "";
  nativeHandler = async (m) => {
    if (m.op === "open-url") {
      verificationUrl = m.value.url;
      return true;
    }
    if (m.op === "folder") return project;
    if (m.op === "server") {
      await pc.addCookies([
        { name: "rimeward_session", value: m.value.session, url: origin },
      ]);
      await desktopPage.goto(m.value.url);
      return true;
    }
    throw new Error("Unexpected native action");
  };
  desktopPage.on("dialog", (d) => {
    errors.push("Unexpected browser dialog: " + d.type());
    void d.dismiss();
  });
  await desktopPage.goto(url);
  await desktopPage.waitForURL("**/desktop/start");
  await desktopPage.screenshot({path:"/tmp/rimeward-first-run.png",fullPage:true,animations:"disabled"});
  await desktopPage
    .getByRole("textbox", { name: "Rimeward server address" })
    .fill(origin);
  await desktopPage
    .getByRole("button", { name: "Continue in browser" })
    .click();
  for (let i = 0; i < 100 && !verificationUrl; i++)
    await new Promise((r) => setTimeout(r, 100));
  assert.ok(verificationUrl);
  assert.equal(await desktopPage.locator(".setup-progress [aria-current]").innerText(), "2\nApprove");
  const approvalContext = await browser.newContext({ ignoreHTTPSErrors: true });
  const approval = await approvalContext.newPage();
  await approval.goto(verificationUrl);
  await approval.waitForURL("**/login");
  await approval.getByLabel("Email", { exact: true }).fill("test@example.com");
  await approval
    .getByLabel("Password", { exact: true })
    .fill("test-only-password");
  await approval.getByRole("button", { name: "Sign in", exact: true }).click();
  await approval.waitForURL("**/desktop/connect?code=*");
  const approved=approval.waitForResponse(r=>r.request().method()==='POST'&&r.url().includes('/desktop/connect'));
  await approval.getByRole("button", { name: "Allow this desktop" }).click();
  const approvalResponse=await approved;
  assert.equal(approvalResponse.status(),200,(await approvalResponse.text()).slice(0,300)+" origin="+approvalResponse.request().headers().origin);
  await desktopPage
    .getByRole("button", { name: "Open server dashboard", exact: true })
    .waitFor().catch(async e=>{throw new Error(e.message+" | desktop: "+await desktopPage.locator('#setup-status').innerText()+" | browser: "+(await approval.evaluate(()=>document.body?.innerText))+" | "+errors.join(';'));});
  await desktopPage
    .getByRole("button", { name: "Open server dashboard", exact: true })
    .click();
  await desktopPage.waitForURL(origin + "/dash");
  assert.equal(
    (
      await desktopPage.evaluate(() =>
        fetch("/api/devices/list").then((r) => r.json()),
      )
    ).length,
    1,
  );
  await approvalContext.close();
  await desktopPage.goto(new URL("/dash", url).href);
  // A terminal without a project exposes the same project creation dialog.
  const isolated = await desktopPage.evaluate(async () => {
    const d = await fetch("/api/runtime").then((r) => r.json());
    const r = await fetch("/api/dashboard", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...d,
        layout: [
          ...d.layout,
          { i: "terminal-empty", type: "terminal", size: "3x2" },
        ],
      }),
    });
    return r.status;
  });
  assert.equal(isolated, 200);
  await desktopPage.reload();
  const terminalCard = desktopPage.locator('[data-wd="terminal-empty"]');
  await terminalCard
    .getByRole("button", { name: "Open / new project" })
    .click();
  await desktopPage
    .getByRole("button", { name: "New project", exact: true })
    .click();
  await desktopPage
    .getByRole("textbox", { name: "Project name", exact: true })
    .fill("terminal-created");
  assert.ok(await desktopPage.locator(".dev-project-dialog").evaluate(el=>parseFloat(getComputedStyle(el).paddingLeft)>=16), "project dialog keeps its padding");
  await desktopPage.screenshot({path:"/tmp/rimeward-project-picker.png",animations:"disabled"});
  await desktopPage
    .getByRole("textbox", { name: "Parent folder", exact: true })
    .fill(temporary);
  await desktopPage
    .getByRole("button", { name: "Create project", exact: true })
    .click();
  await terminalCard.getByRole("button", { name: "Open terminal", exact: true }).waitFor();
  assert.ok(fs.existsSync(path.join(temporary, "terminal-created")));
  // Exercise the button itself instead of bypassing it through the API.
  await desktopPage
    .getByRole("button", { name: "Open project", exact: true })
    .click();
  await desktopPage
    .getByRole("textbox", { name: "Project folder", exact: true })
    .fill(project);
  await desktopPage.getByRole("dialog", { name: "Open a project" })
    .getByRole("button", { name: "Open project", exact: true })
    .click();
  await desktopPage.waitForURL(u=>u.pathname.endsWith("/dash")&&u.hash.startsWith("#p="));
  const preset = { page: new URL(desktopPage.url()).hash.slice(3) };
  const post = async (page, route, body) =>
    page.evaluate(
      async ({ route, body }) => {
        const r = await fetch(route, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        const value = await r.json();
        if (!r.ok) throw new Error(JSON.stringify(value));
        return value;
      },
      { route, body },
    );

  await desktopPage.waitForLoadState("domcontentloaded");
  const p = (
    await desktopPage.evaluate(() =>
      fetch("/api/dev/projects").then((r) => r.json()),
    )
  ).find((p) => p.root === fs.realpathSync(project));
  await phone.addCookies([
    { name: "rimeward_session", value: serverInfo.cookie, url: origin },
  ]);
  const phonePage = await phone.newPage();
  phonePage.on("pageerror", (e) => errors.push(e.message));
  await phonePage.goto(origin + "/dash");

  let devices = [];
  for (let i = 0; i < 30; i++) {
    devices = await phonePage.evaluate(() =>
      fetch("/api/devices/list").then((r) => r.json()),
    );
    if (devices[0]?.online) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(devices[0]?.online);
  const session = await post(desktopPage, "/api/dev/sessions", {
    project: p.id,
    kind: "shell",
    mode: "human",
  });
  await post(desktopPage, "/api/dev/control", {
    id: session.id,
    owner: "client:pc",
    takeover: true,
  });
  await post(desktopPage, "/api/dev/input", {
    id: session.id,
    owner: "client:pc",
    data: "echo " + marker + "\r",
  });
  const base = "/runtime/" + devices[0].id;
  await phonePage.goto(origin + base + "/dash#p=" + preset.page);
  await phonePage.waitForTimeout(1000);
  const remote = await phonePage.evaluate(
    (id) => fetch("/api/dev/sessions?id=" + id).then((r) => r.json()),
    session.id,
  );
  assert.ok(remote.screen.includes(marker));
  await post(phonePage, "/api/dev/control", {
    id: session.id,
    owner: "client:phone",
    takeover: true,
  });
  await post(phonePage, "/api/dev/input", {
    id: session.id,
    owner: "client:phone",
    data: "echo PHONE_CONTINUED\r",
  });
  const initial = await phonePage.evaluate(
    (id) =>
      fetch("/api/dev/buffer?project=" + id + "&path=hello.txt").then((r) =>
        r.json(),
      ),
    p.id,
  );
  await post(phonePage, "/api/dev/buffer", {
    project: p.id,
    path: "hello.txt",
    text: marker,
    revision: initial.revision,
    owner: "client:phone",
  });
  const back = await desktopPage.evaluate(
    (id) =>
      fetch("/api/dev/buffer?project=" + id + "&path=hello.txt").then((r) =>
        r.json(),
      ),
    p.id,
  );
  assert.equal(back.text, marker);
  assert.equal(
    fs.readFileSync(path.join(project, "hello.txt"), "utf8"),
    "hello\n",
  );
  await phonePage
    .locator("[data-wd-type=editor] .editor-explorer")
    .getByRole("button", { name: "hello.txt", exact: true })
    .click();
  await phonePage
    .locator("[data-wd-type=editor] .cm-content")
    .filter({ hasText: marker })
    .waitFor();
  await desktopPage
    .locator("[data-wd-type=editor] .editor-explorer")
    .getByRole("button", { name: "hello.txt", exact: true })
    .click();
  await desktopPage
    .locator("[data-wd-type=editor] .cm-content")
    .filter({ hasText: marker })
    .waitFor();
  const phoneEditor = phonePage.locator("[data-wd-type=editor]");
  await phoneEditor
    .getByRole("button", { name: "Take over", exact: true })
    .click();
  const editable = phoneEditor.locator(".cm-content[contenteditable=true]");
  await editable.waitFor();
  await editable.click();
  await phonePage.keyboard.press(
    process.platform === "darwin" ? "Meta+A" : "Control+A",
  );
  await phonePage.keyboard.insertText(marker + "_UI");
  let edited;
  for (let i = 0; i < 30; i++) {
    edited = await desktopPage.evaluate(
      (id) =>
        fetch("/api/dev/buffer?project=" + id + "&path=hello.txt").then((r) =>
          r.json(),
        ),
      p.id,
    );
    if (edited.text === marker + "_UI") break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(edited.text, marker + "_UI");
  assert.equal(
    fs.readFileSync(path.join(project, "hello.txt"), "utf8"),
    "hello\n",
  );
  await phonePage
    .locator('[data-wd-type=terminal]:not([data-wd-off]) select[aria-label="Terminal session"]')
    .selectOption(session.id, { force: true });
  await phonePage
    .locator("[data-wd-type=terminal]:not([data-wd-off])")
    .getByRole("button", { name: "Expand terminal", exact: true })
    .click();
  await phonePage
    .locator("dialog[open]")
    .getByRole("button", { name: "Take control", exact: true })
    .click();
  await phonePage.waitForFunction(() =>
    document.activeElement?.classList.contains("xterm-helper-textarea"),
  );
  await phonePage.keyboard.type("echo UI_CONTINUED");
  await phonePage.keyboard.press("Enter");
  await phonePage.waitForTimeout(700);
  const visibleInput = await desktopPage.evaluate(
    (id) => fetch("/api/dev/sessions?id=" + id).then((r) => r.json()),
    session.id,
  );
  assert.match(visibleInput.screen, /UI_CONTINUED/);
  await phonePage.screenshot({
    path: "/tmp/rimeward-phone-handoff.png",
    fullPage: true,
  });
  await desktopPage.screenshot({
    path: "/tmp/rimeward-desktop-handoff.png",
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  await phonePage.close();
  const unchanged = await desktopPage.evaluate(
    (id) => fetch("/api/dev/sessions?id=" + id).then((r) => r.json()),
    session.id,
  );
  assert.equal(unchanged.session.id, session.id);
  assert.equal(unchanged.session.state, "running");
  desktop.stdin.write('{"type":"shutdown"}\n');
  await once(desktop, "exit");
  const offline = await phone.newPage();
  const reply = await offline.goto(origin + base + "/dash");
  assert.equal(reply.status(), 503);
  assert.equal((await offline.goto(origin + "/dash")).status(), 200);
  for (const entry of fs.readdirSync(path.join(temporary, "server"))) {
    const filename = path.join(temporary, "server", entry);
    if (fs.statSync(filename).isFile())
      assert.ok(
        !fs.readFileSync(filename).includes(Buffer.from(marker)),
        entry,
      );
  }
  assert.ok(!logs.includes(marker));
  console.log(
    "First-run browser approval, existing server dashboard, project buttons, and PC → phone → PC: same live terminal and recovery buffer; desktop offline keeps server usable; server data/logs contain no desktop marker.",
  );
} finally {
  if (browser) await browser.close();
  for (const p of children) if (p.exitCode === null) p.kill("SIGTERM");
  for (const s of connections) s.destroy();
  proxy?.close();
  fs.rmSync(path.join(repo, "tests/.handoff-server-fixture.mjs"), {
    force: true,
  });
  await new Promise((r) => setTimeout(r, 500));
  fs.rmSync(temporary, { recursive: true, force: true });
}
