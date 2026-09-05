// The header's Notion search popover (AppLayout.astro): a debounced query
// against /api/notion/search. On every app page, not only the dashboard.

import { el, getJson } from './dom.ts';

export function bootNotionSearch(): void {
  const input = document.getElementById('notion-search') as HTMLInputElement | null;
  const results = document.getElementById('notion-search-results');
  if (!input || !results) return;
  let timer: ReturnType<typeof setTimeout>;
  let seq = 0;

  const hide = () => results.classList.add('hidden');
  document.addEventListener('click', (e) => {
    if (!results.contains(e.target as Node) && e.target !== input) hide();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hide();
  });

  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) {
      hide();
      return;
    }
    timer = setTimeout(async () => {
      const mySeq = ++seq;
      const { status, data } = await getJson(`/api/notion/search?q=${encodeURIComponent(q)}`);
      if (mySeq !== seq) return;
      results.textContent = '';
      results.classList.remove('hidden');
      if (status === 404 || status === 409) {
        const a = el('a', 'block px-3 py-2 text-xs text-warn hover:bg-surface-2', 'Connect Notion to search');
        a.setAttribute('href', '/api/connect/notion');
        results.append(a);
        return;
      }
      const items = (data?.results ?? []) as any[];
      if (items.length === 0) {
        results.append(el('div', 'px-3 py-2 text-xs text-ink-faint', 'No matches.'));
        return;
      }
      for (const r of items.slice(0, 8)) {
        const a = el('a', 'block truncate rounded px-3 py-2 text-xs hover:bg-surface-2', r.title || '(untitled)');
        a.setAttribute('href', r.url);
        a.setAttribute('target', '_blank');
        a.setAttribute('rel', 'noreferrer');
        results.append(a);
      }
    }, 300);
  });
}
