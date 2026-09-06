import type { APIRoute } from "astro";
import { relayRequest } from "../../../lib/dev/devices.ts";
import { DevError } from "../../../lib/dev/runtime.ts";
export const ALL: APIRoute = async ({ params, locals, request, url }) => {
  try {
    return await relayRequest(
      locals.user!.userId,
      params.device ?? "",
      "/" + (params.path ?? "") + url.search,
      request,
    );
  } catch (e) {
    return new Response(
      e instanceof DevError ? e.message : "Desktop unavailable.",
      {
        status: e instanceof DevError ? e.status : 502,
        headers: {
          "content-type": "text/plain",
          "cache-control": "no-store",
          "x-accel-buffering": "no",
        },
      },
    );
  }
};
