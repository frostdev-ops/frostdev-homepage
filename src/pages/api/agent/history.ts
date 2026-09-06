import type { APIRoute } from "astro";
import { getDb } from "../../../lib/db.ts";
import {
  sharedChats,
  syncRecord,
  installRecord,
  preserveConflict,
  captureRime,
} from "../../../lib/agent/sync-store.ts";
import { syncRime, syncStatus } from "../../../lib/agent/sync.ts";

export const GET: APIRoute = async ({ locals, url }) => {
  if (!locals.user)
    return Response.json({ error: "Sign in required." }, { status: 401 });
  const user = locals.user.userId;
  await syncRime(user);
  const conflict = url.searchParams.get("conflict");
  if (conflict) {
    const saved = getDb()
      .prepare(
        "SELECT id,key,payload,saved_at FROM agent_sync_conflicts WHERE user_id=? AND id=?",
      )
      .get(user, Number(conflict));
    return Response.json(saved ?? { error: "Recovery version not found." }, {
      status: saved ? 200 : 404,
      headers: { "cache-control": "no-store" },
    });
  }
  const key = url.searchParams.get("key");
  const chats = sharedChats(user);
  return Response.json(
    key
      ? (chats.find((c) => c.key === key) ?? null)
      : {
          chats: chats.map(({ key, title, device, updated }) => ({
            key,
            title,
            device,
            updated,
          })),
          sync: syncStatus(user),
        },
    { headers: { "cache-control": "no-store" } },
  );
};
export const POST: APIRoute = async ({ locals, request }) => {
  if (!locals.user)
    return Response.json({ error: "Sign in required." }, { status: 401 });
  try {
    const user = locals.user.userId,
      body = await request.json();
    if (body.action === "sync") await syncRime(user, true);
    else if (body.conflict) {
      const saved = getDb()
        .prepare(
          "SELECT key,payload FROM agent_sync_conflicts WHERE user_id=? AND id=?",
        )
        .get(user, Number(body.conflict)) as
        | { key: string; payload: string }
        | undefined;
      if (!saved?.key.startsWith("work/"))
        throw Error("Agent file recovery version not found.");
      captureRime(user);
      const current = syncRecord(user, saved.key);
      if (current) preserveConflict(user, current);
      const { createHash } = await import("node:crypto");
      installRecord(user, {
        ...saved,
        hash: createHash("sha256").update(saved.payload).digest("hex"),
      });
      void syncRime(user, true);
    } else {
      const { continueChat } = await import("../../../lib/agent/core.ts");
      await continueChat(user, String(body.ward ?? ""), String(body.key ?? ""));
    }
    return Response.json(
      { ok: true },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : "Could not open history." },
      { status: 400 },
    );
  }
};
