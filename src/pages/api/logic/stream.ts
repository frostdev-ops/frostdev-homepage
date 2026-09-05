import type { APIRoute } from 'astro';
import { subscribeLogic } from '../../../lib/logic-engine.ts';
import { getTimers } from '../../../lib/timers.ts';

export const prerender = false;

// Per-user SSE (unlike /api/status/stream, which is one global snapshot):
// timer state, packet-change notices, client-side acts, and run results.
export const GET: APIRoute = async ({ locals }) => {
  const userId = locals.user!.userId;
  const encoder = new TextEncoder();
  let unsub = () => {};
  let ping: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream({
    start(controller) {
      const send = (event: string, data: unknown) => {
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {}
      };
      for (const t of getTimers(userId)) send('timer', t);
      unsub = subscribeLogic(userId, send); // also flushes any pending acts
      ping = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': ping\n\n'));
        } catch {}
      }, 25_000);
    },
    cancel() {
      unsub();
      if (ping) clearInterval(ping);
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      // nginx must not buffer this (same as the status stream).
      'x-accel-buffering': 'no',
    },
  });
};
