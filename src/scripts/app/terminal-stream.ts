import type { RuntimeEvent } from "../../lib/dev/types.ts";

type Listener = (event: RuntimeEvent | null) => void;
const streams = new Map<string, {
  listeners: Map<Listener, string>;
  source?: EventSource;
  retry?: ReturnType<typeof setTimeout>;
  ready?: boolean;
  connect: () => void;
}>();

/** One connection per desktop, shared by all terminal wards. null = disconnected. */
export function terminalEvents(device: string, ward: string, listener: Listener) {
  let stream = streams.get(device);
  if (!stream) {
    stream = { listeners: new Map(), connect: () => {} };
    streams.set(device, stream);
    const current = stream;
    current.connect = () => {
      clearTimeout(current.retry);
      current.source?.close();
      current.ready = false;
      for (const receive of current.listeners.keys()) receive(null);
      const routingWard = current.listeners.values().next().value;
      if (!routingWard) return;
      const source = new EventSource(`/api/dev/events?_ward=${encodeURIComponent(routingWard)}`);
      current.source = source;
      source.onmessage = message => {
        if (current.source !== source) return;
        const event = JSON.parse(message.data) as RuntimeEvent;
        if (event.type === "reset") current.ready = true;
        for (const receive of current.listeners.keys()) receive(event);
      };
      source.onerror = () => {
        if (current.source !== source) return;
        current.ready = false;
        for (const receive of current.listeners.keys()) receive(null);
        if (source.readyState === EventSource.CLOSED) current.retry = setTimeout(current.connect, 3000);
      };
    };
  }
  stream.listeners.set(listener, ward);
  if (!stream.source) stream.connect();
  else if (stream.ready) listener({ type: "reset", sequence: 0, id: "" });
  return () => {
    const routingWard = stream.listeners.values().next().value;
    stream.listeners.delete(listener);
    if (!stream.listeners.size) {
      clearTimeout(stream.retry); stream.source?.close(); streams.delete(device);
    } else if (routingWard === ward) stream.connect();
  };
}
