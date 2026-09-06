import { desktopApi, chooseProject } from "./workspace-dialogs.ts";
import { el } from "./dom.ts";
const root = document.querySelector<HTMLElement>(".desktop-setup")!,
  status = document.getElementById("setup-status")!,
  form = document.getElementById("setup-form") as HTMLFormElement,
  submit = document.getElementById("setup-submit") as HTMLButtonElement,
  wait = document.getElementById("setup-wait")!,
  connected = document.getElementById("setup-connected")!;
let requestId = "",
  timer: ReturnType<typeof setTimeout> | undefined;
function step(value: "connect" | "approve" | "ready") {
  root.dataset.step = value;
  root.querySelectorAll<HTMLElement>(".setup-progress li").forEach(li => {
    if (li.dataset.step === value) li.setAttribute("aria-current", "step");
    else li.removeAttribute("aria-current");
  });
  status.dataset.error = "false";
}
const report = (e: unknown) => {
  status.dataset.error = "true";
  status.textContent = e instanceof Error ? e.message : String(e);
};
const action = (label: string, fn: () => Promise<unknown>) => {
  const b = el("button", "btn", label);
  b.type = "button";
  b.onclick = () => {
    b.disabled = true;
    void fn()
      .catch(report)
      .finally(() => {
        b.disabled = false;
      });
  };
  return b;
};
async function openServer(id: string) {
  status.textContent = "Opening your server dashboard…";
  await desktopApi("onboard", { home: id });
  await desktopApi("open-server", { id });
}
function showConnected(p: { id: string; server: string; email?: string }) {
  connected.hidden = false;
  const row = el("div", "setup-connected-row");
  step("ready");
  row.append(
    el("strong", undefined, p.server),
    el(
      "p",
      undefined,
      p.email ? "Connected as " + p.email : "Already connected to this server",
    ),
    action("Open server dashboard", () => openServer(p.id)),
  );
  connected.append(row);
}
async function poll() {
  const id = requestId;
  if (!id) return;
  try {
    const result = await desktopApi("sign-in-poll", { id });
    if (id !== requestId) return;
    if (result.status === "connected") {
      requestId = "";
      wait.hidden = true;
      submit.disabled = false;
      status.textContent =
        "Connected. Your existing server dashboard is ready.";
      showConnected(result);
      return;
    }
    timer = setTimeout(() => void poll(), 3100);
  } catch (e) {
    if (id === requestId) {
      requestId = "";
      wait.hidden = true;
      submit.disabled = false;
      step("connect");
      report(e);
    }
  }
}
async function cancel() {
  clearTimeout(timer);
  const id = requestId;
  requestId = "";
  wait.hidden = true;
  step("connect");
  submit.disabled = false;
  if (id) await desktopApi("sign-in-cancel", { id });
}
form.onsubmit = async (e) => {
  e.preventDefault();
  if (!form.reportValidity()) return;
  submit.disabled = true;
  try {
    await cancel();
    submit.disabled = true;
    status.textContent = "Connecting to your server…";
    const input = form.elements.namedItem("server") as HTMLInputElement;
    const raw = input.value.trim(),
      server = /^https?:\/\//i.test(raw) ? raw : "https://" + raw;
    const result = await desktopApi("sign-in-start", { server });
    requestId = result.id;
    document.getElementById("setup-code")!.textContent = result.userCode;
    (document.getElementById("setup-link") as HTMLAnchorElement).href =
      result.verificationUrl;
    wait.hidden = false;
    step("approve");
    status.textContent = result.browserOpened
      ? "Waiting for your approval in the browser…"
      : "Use the approval link below to finish connecting.";
    timer = setTimeout(() => void poll(), 3100);
  } catch (e) {
    submit.disabled = false;
    report(e);
  }
};
document.getElementById("setup-reopen")!.onclick = () =>
  void desktopApi("sign-in-open", { id: requestId }).catch(report);
document.getElementById("setup-cancel")!.onclick = () =>
  void cancel()
    .then(() => {
      status.textContent = "Connection cancelled.";
    })
    .catch(report);
document.getElementById("setup-local")!.onclick = () =>
  void cancel()
    .then(() => desktopApi("onboard", { home: "local" }))
    .then(() => location.assign("/dash"))
    .catch(report);
document.getElementById("setup-project")!.onclick = async () => {
  try {
    const p = await chooseProject();
    if (!p) return;
    const { page } = await desktopApi("open-project", { project: p.id });
    await cancel();
    await desktopApi("onboard", { home: "local" });
    location.assign("/dash#p=" + page);
  } catch (e) {
    report(e);
  }
};
window.addEventListener("pagehide", () => clearTimeout(timer));
void desktopApi("onboarding")
  .then(async (state) => {
    for (const p of state.pairs) showConnected(p);
    if (state.complete && root.dataset.setup !== "1") {
      if (state.home === "local") {
        location.replace("/dash");
        return;
      }
      try {
        await openServer(state.home);
      } catch (e) {
        report(e);
      }
    }
  })
  .catch(report);
