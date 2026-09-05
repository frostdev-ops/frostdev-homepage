// The communication wards' contract — pure, ships to the browser (the chat
// renderer and logic.ts import it), never touches the db. One ward type per
// service; every service implements the same CommsClient so the routes, the
// logic execs, the agent tools and the renderer never name a provider.

/** Every chat ward type. Widened per phase (slack, telegram, twilio, push,
 *  matrix, teams); logic's wardType arrays and the renderer loop read it. */
export const COMMS_TYPES = ['discord', 'telegram', 'slack', 'twilio', 'push', 'matrix', 'teams'] as const;
export type CommsType = (typeof COMMS_TYPES)[number];
/** The types that can hear anything — a push ward only sends. Triggers anchor on these. */
export const COMMS_INBOUND = COMMS_TYPES.filter((t) => t !== 'push');
export const isCommsType = (t: unknown): t is CommsType => (COMMS_TYPES as readonly unknown[]).includes(t);

export interface ChatAttachment {
  url: string;
  name: string;
  size?: number;
}

/** One message as every provider reports it. `id` is the provider's own id,
 *  unique within a ward — the store's primary key. */
export interface ChatMessage {
  id: string;
  channel: string;
  channelName?: string;
  from: { id: string; name: string };
  text: string;
  /** unix ms */
  at: number;
  attachments?: ChatAttachment[];
  threadId?: string;
  replyTo?: string;
  /** Sent by this ward's bot. */
  mine?: boolean;
  /** Addressed to the bot: a mention, a reply to it, or a DM. */
  mention?: boolean;
  /** A DM / private chat with the bot — always watched, whatever the list. */
  direct?: boolean;
  /** Another bot / webhook wrote it — never fires logic (bot ping-pong). */
  bot?: boolean;
  /** The server (Discord guild, Slack workspace) it came from, when the
   *  provider scopes messages that way — the ward filters on it. */
  guild?: string;
}

export interface ChatChannel {
  id: string;
  name: string;
  kind?: string;
  parent?: string;
}

export type CommsEvent =
  /** quiet = store it, never fire (what arrived while nobody was listening). */
  | { type: 'message'; message: ChatMessage; quiet?: boolean }
  | { type: 'reaction'; channel: string; messageId: string; emoji: string; from: { id: string; name: string }; guild?: string }
  | { type: 'member-joined'; member: { id: string; name: string }; channel?: string; guild?: string }
  /** The connection's own state, for the ward's status line. */
  | { type: 'state'; status: 'connecting' | 'ready' | 'error' | 'closed'; error?: string; note?: string };

export interface SendOpts {
  /** Reply to this message id (a quote / thread reply where the provider has one). */
  replyTo?: string;
  /** Answer in a thread hung off replyTo rather than in the channel. */
  thread?: boolean;
}

export interface Whoami {
  id: string;
  name: string;
  /** Provider extras for the status card (Discord: application id + invite link). */
  extra?: Record<string, string>;
}

export interface CommsClient {
  type: CommsType;
  /** What a destination (channel / chat / number) must look like — the
   *  guard on every send, so a template can never redirect one. */
  destRe: RegExp;
  maxText: number;
  whoami(): Promise<Whoami>;
  channels(): Promise<ChatChannel[]>;
  /** A channel's display name if this client has seen it. */
  nameOf(channel: string): string | undefined;
  history(channel: string, limit: number): Promise<ChatMessage[]>;
  send(channel: string, text: string, opts?: SendOpts): Promise<ChatMessage>;
  react(channel: string, messageId: string, emoji: string): Promise<void>;
  /** Provider-specific reads (Discord: guild, roles, members, threads, pins, channel, message). */
  read(what: string, args: Record<string, unknown>): Promise<unknown>;
  /** Structure changes that are reversible in the product (create/edit channel, threads, roles, pins, invites). */
  manage(op: string, args: Record<string, unknown>): Promise<unknown>;
  /** The destructive ones (delete, kick, ban, timeout). */
  moderate(op: string, args: Record<string, unknown>): Promise<unknown>;
  /** The op vocabulary, for the tool descriptions — static text, byte-identical across turns. */
  ops: { read: string[]; manage: string[]; moderate: string[] };
  /** Open the live feed; the returned function closes it. Synchronous on
   *  purpose — the SIGTERM handler cannot await. */
  live(onEvent: (e: CommsEvent) => void): () => void;
}

export function unsupported(type: string, what: string): never {
  throw new Error(`${what} is not supported on ${type}`);
}

/** Template vars a message-arrived / reaction-added firing carries. */
export function messageVars(m: ChatMessage): Record<string, string> {
  return {
    'msg.text': m.text.slice(0, 4000),
    'msg.from': m.from.name,
    'msg.fromId': m.from.id,
    'msg.channel': m.channel,
    'msg.channelName': m.channelName ?? '',
    'msg.id': m.id,
    'msg.attachments': (m.attachments ?? []).map((a) => a.name).join(', '),
  };
}
