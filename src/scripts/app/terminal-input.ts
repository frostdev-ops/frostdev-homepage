/** Coalesce keystrokes while a request is in flight; never retry a mutation. */
export class TerminalInput {
  private pending: { id: string; data: string; binary: boolean }[] = [];
  private size = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private sending?: Promise<void>;
  private write: (id: string, data: string, binary: boolean) => Promise<unknown>;
  private failed: (id: string, error: unknown) => void;
  constructor(
    write: (id: string, data: string, binary: boolean) => Promise<unknown>,
    failed: (id: string, error: unknown) => void,
  ) { this.write = write; this.failed = failed; }
  send(id: string, data: string, binary = false) {
    if (this.size + data.length > 1024 * 1024) {
      this.clear();
      this.failed(id, new Error("Input queue is full. Review the terminal before continuing."));
      return;
    }
    const last = this.pending.at(-1);
    if (last?.id === id && last.binary === binary) last.data += data;
    else this.pending.push({ id, data, binary });
    this.size += data.length;
    this.timer ??= setTimeout(() => { void this.flush(); }, 8);
  }
  flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.sending) return this.sending;
    this.sending = (async () => {
      while (this.pending.length) {
        const entry = this.pending[0];
        if (!entry) break;
        // 16k UTF-16 units fit the 64k-byte API limit, including non-ASCII paste.
        let end = Math.min(16000, entry.data.length);
        if (end < entry.data.length && /[\uD800-\uDBFF]/.test(entry.data.charAt(end - 1))) end--;
        const data = entry.data.slice(0, end);
        entry.data = entry.data.slice(end);
        this.size -= data.length;
        if (!entry.data) this.pending.shift();
        try { await this.write(entry.id, data, entry.binary); }
        catch (error) { this.clear(); this.failed(entry.id, error); break; }
      }
    })().finally(() => { this.sending = undefined; });
    return this.sending;
  }
  clear() {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.pending = [];
    this.size = 0;
  }
}
