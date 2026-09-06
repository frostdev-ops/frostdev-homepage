import { desktopApi } from "./workspace-dialogs.ts";
import { el, toast } from "./dom.ts";
const host = document.getElementById("runtime-picker");
if (host) {
  const base = document.querySelector<HTMLMetaElement>(
    'meta[name="rimeward-runtime-base"]',
  )?.content;
  const native = host.dataset.desktop === "1";
  const picker = el("select", "input text-xs");
  picker.setAttribute("aria-label", "Environment");
  const serverFetch =
    (window as any).rimewardServerFetch ?? window.fetch.bind(window);
  if (base) {
    picker.add(new Option("Server", "/dash"));
    picker.add(new Option("Connected desktop", base + "/dash", true, true));
  } else
    picker.add(
      new Option(
        native ? "This desktop" : "Server",
        location.pathname,
        true,
        true,
      ),
    );
  host.append(picker);
  void (
    base || !native
      ? serverFetch("/api/devices/list", { cache: "no-store" })
      : fetch("/api/dev/pairings", { cache: "no-store" })
  )
    .then((r: Response) => r.json())
    .then((list: any[]) => {
      if (!Array.isArray(list)) return;
      for (const d of list) {
        const url =
          native && !base ? "server:" + d.id : "/runtime/" + d.id + "/dash";
        if (base === "/runtime/" + d.id) continue;
        const option = new Option(
          (native && !base ? new URL(d.server).host : d.name) +
            (!native && !d.online ? " · offline" : ""),
          url,
        );
        option.disabled = !native && !d.online;
        picker.add(option);
      }
    })
    .catch(() => {});
  picker.onchange = () => {
    if (native && !base && picker.value.startsWith("server:")) {
      void desktopApi("open-server", { id: picker.value.slice(7) }).catch((e) =>
        toast(e.message),
      );
    } else location.assign(picker.value);
  };
}

document
  .getElementById("manage-environments")
  ?.addEventListener("click", () => location.assign("/devices"));
