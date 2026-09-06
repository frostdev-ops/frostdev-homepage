import type { APIRoute } from "astro";
import { isDesktop } from "../../lib/dev/runtime.ts";
import { getDashboard, getPages } from "../../lib/dashboard.ts";
export const GET: APIRoute = ({ locals }) => {
  const user = locals.user;
  if (!user)
    return Response.json({ error: "Sign in required." }, { status: 401 });
  return Response.json(
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
      pages: getPages(user.userId),
      layout: getDashboard(user.userId),
      theme: user.theme,
    },
    { headers: { "cache-control": "no-store" } },
  );
};
