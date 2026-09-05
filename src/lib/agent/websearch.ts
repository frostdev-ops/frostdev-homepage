import { agentKey } from './accounts.ts';
import { vettedFetch } from './shell.ts';

// Web search for the agent. Two providers on purpose, because they answer
// different questions: Brave is a keyword index (a part number, a datasheet, a
// changelog), Exa is semantic (a description of a thing nobody can name
// exactly). Merged into one ranked list; choosing a search engine is not worth
// an agent round. Keys are per-user (agent_accounts), like everything agent.
//
// Both go through vettedFetch, the same private-range-checked client the shell
// sandbox uses — a search API is still an outbound request from this box.

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
  source: 'brave' | 'exa';
}

const TIMEOUT_MS = 15_000;
const KEY_HINT = 'no search key — add a Brave or Exa key under Account → Agent';

/** Brave wraps matched terms in <strong>; what the agent wants is the sentence. */
const plain = (s: unknown): string =>
  String(s ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();

async function fetchJson(url: string, options: Parameters<typeof vettedFetch>[1]): Promise<any> {
  const res = await vettedFetch(url, { timeoutMs: TIMEOUT_MS, ...options });
  const body = new TextDecoder().decode(res.body);
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`${new URL(url).hostname} ${res.status}: ${body.slice(0, 200)}`);
  }
  return JSON.parse(body);
}

async function brave(userId: number, query: string, count: number): Promise<SearchHit[]> {
  const key = agentKey(userId, 'brave');
  if (!key) return [];
  const data = await fetchJson(
    `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`,
    { headers: { 'X-Subscription-Token': key, Accept: 'application/json' } }
  );
  const results: any[] = Array.isArray(data?.web?.results) ? data.web.results : [];
  return results
    .map((r) => ({
      title: plain(r.title),
      url: String(r.url ?? ''),
      snippet: plain(r.description).slice(0, 300),
      source: 'brave' as const,
    }))
    .filter((h) => h.url);
}

async function exa(userId: number, query: string, count: number): Promise<SearchHit[]> {
  const key = agentKey(userId, 'exa');
  if (!key) return [];
  const data = await fetchJson('https://api.exa.ai/search', {
    method: 'POST',
    headers: { 'x-api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, numResults: count, contents: { highlights: true } }),
  });
  const results: any[] = Array.isArray(data?.results) ? data.results : [];
  return results
    .map((r) => ({
      title: plain(r.title),
      url: String(r.url ?? ''),
      snippet: plain(Array.isArray(r.highlights) ? r.highlights.join(' … ') : r.text).slice(0, 300),
      source: 'exa' as const,
    }))
    .filter((h) => h.url);
}

/** Same page, two spellings of its URL — worth catching before we scrape both. */
const dedupeKey = (url: string): string => {
  try {
    const u = new URL(url);
    return `${u.hostname.replace(/^www\./, '')}${u.pathname.replace(/\/$/, '')}${u.search}`.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
};

/**
 * Whichever providers have keys, merged. One provider configured is a working
 * search; one provider erroring while the other answers is still an answer —
 * it only throws when nothing at all came back.
 */
export async function webSearch(userId: number, query: string, count = 5): Promise<SearchHit[]> {
  const q = String(query ?? '').trim();
  if (!q) throw new Error('query is required');
  if (!agentKey(userId, 'brave') && !agentKey(userId, 'exa')) throw new Error(KEY_HINT);

  const settled = await Promise.allSettled([brave(userId, q, count), exa(userId, q, count)]);
  const lists = settled.map((s) => (s.status === 'fulfilled' ? s.value : []));
  if (lists.every((l) => !l.length)) {
    const failed = settled.filter((s): s is PromiseRejectedResult => s.status === 'rejected');
    if (failed.length) {
      throw new Error(`search failed: ${failed.map((f) => f.reason?.message ?? String(f.reason)).join('; ')}`);
    }
    return [];
  }

  // Interleaved rather than concatenated: each provider's best result outranks
  // the other's second, so neither engine owns the top of the list.
  const out: SearchHit[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < count && out.length < count; i++) {
    for (const list of lists) {
      const hit = list[i];
      if (!hit || out.length >= count) continue;
      const key = dedupeKey(hit.url);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(hit);
    }
  }
  return out;
}
