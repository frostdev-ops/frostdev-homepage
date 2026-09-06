import type { APIRoute } from "astro";
import { isDesktop } from "../../lib/dev/runtime.ts";
import { getDashboard, getPages } from "../../lib/dashboard.ts";
export const GET: APIRoute = ({ locals }) =>
  Response.json(
    {
      runtime: {
        id: isDesktop() ? "desktop" : "server",
        kind: isDesktop() ? "desktop" : "server",
        protocol: 1,
        capabilities: {
          projects: isDesktop(),
          terminals: isDesktop(),
          editor: isDesktop(),
          agent: true,
          browser: true,
        },
      },
      selectedRuntime: isDesktop() ? "desktop" : "server",
      pages: getPages(locals.user!.userId),
      layout: getDashboard(locals.user!.userId),
      theme: locals.user!.theme,
    },
    { headers: { "cache-control": "no-store" } },
  );
