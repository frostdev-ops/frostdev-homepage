import { desktopApi, prepareWorkspaceNavigation } from "./workspace-dialogs.ts";
import { el, toast } from "./dom.ts";
import { icon } from "./icon.ts";
import type { WorkspaceEntry, WorkspaceNavigation } from "../../lib/dev/types.ts";
import "../../styles/workspaces.css";

type NativeWindow = Window & { __TAURI__?: { core: { invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> } }; rimewardServerFetch?: typeof fetch };
const native = (window as NativeWindow).__TAURI__?.core;
const serverFetch = (window as NativeWindow).rimewardServerFetch ?? window.fetch.bind(window);
const base = document.querySelector<HTMLMetaElement>('meta[name="rimeward-runtime-base"]')?.content;
const host = document.getElementById("runtime-picker");
const local = host?.dataset.desktop === "1" && !base;
let navigation: WorkspaceNavigation | undefined;
let nativeNavigation = false;
async function json<T>(url: string): Promise<T> {
  const response = await serverFetch(url, { cache: "no-store", signal: AbortSignal.timeout(6000) });
  if (!response.ok) throw Error(response.status === 401 ? "Sign in to reconnect" : "Connection unavailable");
  return response.json();
}
async function readNavigation(): Promise<WorkspaceNavigation> {
  if (native) {
    try { const result = await native.invoke<WorkspaceNavigation>("workspace_navigation"); nativeNavigation = true; return result; }
    catch { /* Older native clients retain web access and show an update action below. */ }
  }
  if (local) return desktopApi<WorkspaceNavigation>("navigation");
  const [server, devices] = await Promise.all([
    json<Pick<WorkspaceEntry, "pages" | "activePage">>("/api/runtime?navigation=1"),
    json<{ id: string; name: string; online: boolean }[]>("/api/devices/list"),
  ]);
  const workspaces: WorkspaceEntry[] = [{ id: "server", name: location.host, kind: "server", online: true, ...server }];
  workspaces.push(...await Promise.all(devices.map(async device => {
    const entry: WorkspaceEntry = { ...device, kind: "desktop", pages: [] };
    if (device.online) {
      try { Object.assign(entry, await json(`/runtime/${device.id}/api/runtime?navigation=1`)); }
      catch (e) { entry.online = false; entry.error = (e as Error).message; }
    }
    return entry;
  })));
  return { current: base?.split("/")[2] ?? "server", workspaces };
}
async function go(entry: WorkspaceEntry, page?: string) {
  await prepareWorkspaceNavigation();
  if (entry.id === navigation?.current && !base) {
    location.assign(`/dash${page ? `#p=${encodeURIComponent(page)}` : ""}`); return;
  }
  if (nativeNavigation && native) await native.invoke("open_workspace", { runtime: entry.id, page });
  else if (local) await desktopApi("navigate", { runtime: entry.id, page });
  else {
    const target = entry.kind === "server" ? "/dash" : `/runtime/${entry.id}/dash`;
    location.assign(target + (page ? `#p=${encodeURIComponent(page)}` : ""));
  }
}
async function connections() {
  await prepareWorkspaceNavigation();
  if (nativeNavigation && native) await native.invoke("open_workspace", { runtime: "local", screen: "connections" });
  else location.assign(local ? "/desktop/start?setup=1" : "/devices");
}
if (host) {
  const trigger = el("button", "workspace-trigger"), label = el("span", "workspace-current", local ? "This computer" : "Workspaces");
  trigger.type = "button"; trigger.setAttribute("aria-label", "Workspaces"); trigger.setAttribute("aria-haspopup", "dialog"); trigger.setAttribute("aria-expanded", "false");
  trigger.append(icon("folder"), label, icon("right", "workspace-chevron"));
  const panel = el("div", "workspace-panel"), heading = el("div", "workspace-heading"), search = el("input", "input workspace-search"), list = el("div", "workspace-list"), status = el("p", "workspace-status"), footer = el("div", "workspace-footer");
  panel.id = "workspace-panel"; panel.popover = "auto"; panel.setAttribute("role", "dialog"); panel.setAttribute("aria-label", "Your workspaces"); trigger.setAttribute("aria-controls", panel.id);
  heading.append(el("strong", undefined, "Your workspaces"), el("small", undefined, "One place. Every connected device."));
  search.type = "search"; search.placeholder = "Find a page or computer…"; search.setAttribute("aria-label", "Find a workspace");
  status.setAttribute("role", "status"); status.textContent = "Connecting…";
  const manage = el("button", "workspace-connect", "Connect a server or desktop"); manage.type = "button"; manage.prepend(icon("plus"));
  manage.onclick = () => void connections().catch(e => toast(String(e instanceof Error ? e.message : e)));
  footer.append(manage, el("small", undefined, "Live remote control · project files stay on their computer"));
  panel.append(heading, search, status, list, footer); host.append(trigger, panel);
  const navigate = (entry: WorkspaceEntry, page?: string) => {
    if (trigger.disabled) return;
    trigger.disabled = true; list.inert = true; manage.disabled = true;
    status.textContent = "Opening workspace…";
    void go(entry, page).then(() => panel.hidePopover()).catch(e => { status.textContent = String(e instanceof Error ? e.message : e); }).finally(() => { trigger.disabled = false; list.inert = false; manage.disabled = false; });
  };
  function render() {
    if (!navigation) return;
    const term = search.value.trim().toLowerCase();
    list.replaceChildren();
    for (const entry of navigation.workspaces) {
      const current = entry.id === navigation.current;
      const group = el("section", "workspace-group"), title = el("button", "workspace-source"), details = el("span", "workspace-source-text");
      title.type = "button"; title.disabled = !entry.online;
      title.dataset.current = String(current); title.dataset.online = String(entry.online);
      details.append(el("strong", undefined, entry.id === "local" ? "This computer" : entry.name), el("small", undefined,
        entry.id === "local" ? `${entry.name} · direct connection` : entry.error ?? (entry.online ? entry.kind === "server" ? "Server dashboard" : "Live remote control" : "Offline · reconnect this computer to continue")));
      title.append(icon(entry.kind === "desktop" ? "code" : "route"), details, icon(current ? "check" : "right"));
      title.onclick = () => navigate(entry, entry.activePage);
      group.append(title);
      const pages = entry.pages.filter(p => !term || `${entry.name} ${p.title}`.toLowerCase().includes(term));
      for (const page of pages) {
        const b = el("button", "workspace-page"); b.type = "button"; b.disabled = !entry.online; b.setAttribute("aria-label", page.title);
        b.append(icon("page"), el("span", undefined, page.title));
        if (current && page.id === (new URLSearchParams(location.hash.slice(1)).get("p") ?? entry.activePage)) b.setAttribute("aria-current", "page");
        b.onclick = () => navigate(entry, page.id); group.append(b);
      }
      if (!term || pages.length || entry.name.toLowerCase().includes(term)) list.append(group);
    }
    if (!list.children.length) list.append(el("p", "workspace-status", "No matching pages or computers."));
  }
  let refreshing: Promise<void> | undefined;
  function refresh() {
    if (refreshing) return refreshing;
    refreshing = readNavigation().then(async value => {
      navigation = value;
      // A Mac must not relay itself through the Internet. Other devices still use the relay.
      const own = value.workspaces.find(w => w.id === value.current && w.kind === "server");
      const ownDesktop = value.workspaces.find(w => w.id === "local");
      if (nativeNavigation && base && ownDesktop && own?.device === base.split("/")[2]) {
        await go(ownDesktop, new URLSearchParams(location.hash.slice(1)).get("p") ?? undefined); return;
      }
      label.textContent = value.workspaces.find(w => w.id === value.current)?.name ?? "Workspaces";
      if (value.current === "local") label.textContent = "This computer";
      status.textContent = native && !nativeNavigation ? "Update the desktop app for a direct connection to this computer." : "";
      render();
    }).catch(e => { status.textContent = (e as Error).message; }).finally(() => { refreshing = undefined; });
    return refreshing;
  }
  const position = () => {
    const r = trigger.getBoundingClientRect();
    panel.style.left = `${Math.max(8, r.right - Math.min(420, innerWidth - 16))}px`;
    panel.style.top = `${r.bottom + 8}px`;
  };
  trigger.onclick = () => { position(); panel.togglePopover(); };
  panel.addEventListener("toggle", e => {
    const open = (e as ToggleEvent).newState === "open"; trigger.setAttribute("aria-expanded", String(open));
    if (!open) return;
    position(); search.focus(); void refresh();
  });
  search.oninput = render;
  panel.onkeydown = e => {
    if (!["ArrowDown", "ArrowUp"].includes(e.key)) return;
    e.preventDefault(); const buttons = [...list.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    buttons[(at + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus();
  };
  // Native navigation is needed even when a relay is unavailable; browser lists load on demand.
  if (native || local || base) void refresh();
  else label.textContent = location.host;
}
document.getElementById("manage-environments")?.addEventListener("click", () => void connections().catch(e => toast((e as Error).message)));
