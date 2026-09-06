import { runtimeNavigation, rememberPage } from "../../lib/dev/navigation.ts";
import { DevError } from "../../lib/dev/runtime.ts";
import type { APIRoute } from "astro";
import { isDesktop } from "../../lib/dev/runtime.ts";
import { getDashboard, getPages } from "../../lib/dashboard.ts";
export const GET: APIRoute = ({ locals, url }) => {
  const user = locals.user;
  if (!user)
    return Response.json({ error: "Sign in required." }, { status: 401 });
  if (url.searchParams.has("navigation")) return Response.json(runtimeNavigation(user.userId), { headers: { "cache-control": "no-store" } });
  return Response.json(
    {
      ...runtimeNavigation(user.userId),
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

export const POST: APIRoute = async ({ locals, request }) => {
  if (!locals.user) return Response.json({ error: "Sign in required." }, { status: 401 });
  try { return Response.json(rememberPage(locals.user.userId, (await request.json()).page), { headers: { "cache-control": "no-store" } }); }
  catch (e) { return Response.json({ error: e instanceof DevError ? e.message : "Invalid page." }, { status: e instanceof DevError ? e.status : 400 }); }
};
