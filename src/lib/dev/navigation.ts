import { getPages } from "../dashboard.ts";
import { getSetting, setSetting } from "../settings.ts";
import { DevError, isDesktop } from "./runtime.ts";

/** One remembered page per runtime/account, shared by local and relayed clients. */
export function runtimeNavigation(user: number) {
  const pages = getPages(user).map(({ id, title }) => ({ id, title }));
  const saved = getSetting(`workspace:page:${user}`);
  return { kind: isDesktop() ? "desktop" as const : "server" as const, pages,
    activePage: pages.find(p => p.id === saved)?.id ?? pages[0]?.id };
}
export function rememberPage(user: number, page: unknown) {
  if (typeof page !== "string" || !getPages(user).some(p => p.id === page))
    throw new DevError("Page not found.", 404);
  setSetting(`workspace:page:${user}`, page);
  return { ok: true };
}
/** Only app-owned destinations. Never allow an external URL through native navigation. */
export function workspacePath(page?: string, screen?: string) {
  if (screen === "connections") return "/desktop/start?setup=1";
  if (screen !== undefined || (page !== undefined && (typeof page !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(page))))
    throw new DevError("Invalid workspace destination.");
  return `/dash${page ? `#p=${encodeURIComponent(page)}` : ""}`;
}
