// Loading font faces the page did not ship with.
//
// A page declares only the faces it paints (AppLayout), which keeps its head at
// a couple of KB instead of forty. Two things need more than that: a picker,
// which previews the whole catalogue, and a font chosen at runtime, which has
// to paint before the next reload. Both fetch /fonts and adopt its <style>.

// Seeded with what the page shipped (AppLayout stamps the ids), so the first
// applyThemeLive of a page never re-fetches the face it is already painting.
const haveFaces = new Set<string>(
  (document.querySelector<HTMLMetaElement>('meta[name="fd-faces"]')?.content ?? '').split(',').filter(Boolean)
);
let previewsAsked = false;

/** Fetch a /fonts response and move its @font-face rules into this document. */
async function adopt(url: string): Promise<void> {
  const res = await fetch(url).catch(() => null);
  if (!res?.ok) return;
  // Parsed, not innerHTML'd: only the CSS text of <style> elements is taken,
  // so nothing else in the response can end up in the page.
  const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
  const css = [...doc.querySelectorAll('style')]
    .map((s) => s.textContent ?? '')
    .filter((t) => t.includes('@font-face'))
    .join('\n');
  if (!css) return;
  const style = document.createElement('style');
  style.dataset.fdFonts = '';
  style.textContent = css;
  document.head.append(style);
}

/** Make sure these families can paint — a picker only loaded a glyph subset of
 *  them, and the page only shipped the ones it was already using. */
export function ensureFonts(ids: (string | null | undefined)[]): void {
  const want = [...new Set(ids)].filter((id): id is string => !!id && !haveFaces.has(id));
  if (!want.length) return;
  for (const id of want) haveFaces.add(id);
  void adopt(`/fonts?ids=${want.map(encodeURIComponent).join(',')}`);
}

/** The label-glyph subsets every picker row renders in. ~220KB for the whole
 *  catalogue, and only for someone who actually opens a picker. */
export function loadFontPreviews(): void {
  if (previewsAsked) return;
  previewsAsked = true;
  void adopt('/fonts?preview=1');
}

// One delegated listener for every picker on the page: touching one is what
// pays for the previews, so nobody who never opens one downloads a byte.
for (const ev of ['pointerdown', 'focusin'] as const) {
  document.addEventListener(
    ev,
    (e) => {
      if ((e.target as HTMLElement | null)?.closest?.('[data-font-picker]')) loadFontPreviews();
    },
    true
  );
}
