// Client icon renderer — the DOM twin of components/Icon.astro. Reads the
// theme's icon slice off <html data-icons> (themeHtmlAttrs stamps it, the live
// editor restamps it) and draws a semantic id as emoji text, a currentColor
// mask, or an <img> for the colour weather art. Every icon carries data-icon
// so repaintIcons() can redraw the page when the theme changes under it.

import { iconRef, type IconCfg } from '../../lib/icon-names.ts';

const OWN = new Set(['fd-ic', 'fd-ic-e', 'fd-ic-img']);

function cfg(): IconCfg | null {
  const s = document.documentElement.dataset.icons;
  try {
    return s ? (JSON.parse(s) as IconCfg) : null;
  } catch {
    return null;
  }
}

export function icon(id: string, cls = '', title?: string): HTMLElement {
  const r = iconRef(cfg(), id);
  let n: HTMLElement;
  if (r.kind === 'text') {
    n = document.createElement('span');
    n.className = 'fd-ic-e';
    n.textContent = r.text;
  } else if (r.kind === 'img') {
    const i = document.createElement('img');
    i.className = 'fd-ic-img';
    i.src = r.url;
    i.alt = '';
    n = i;
  } else {
    n = document.createElement('span');
    n.className = 'fd-ic';
    n.style.setProperty('--ic', `url("${r.url}")`);
  }
  if (cls) n.className += ` ${cls}`;
  n.dataset.icon = id;
  if (title) n.title = title;
  return n;
}

/** Redraw every icon on the page from the current <html data-icons>. */
export function repaintIcons(): void {
  for (const old of document.querySelectorAll<HTMLElement>('[data-icon]')) {
    const extra = [...old.classList].filter((c) => !OWN.has(c)).join(' ');
    old.replaceWith(icon(old.dataset.icon!, extra, old.title || undefined));
  }
}

/** A toolbar button is icon + label; the label hides on narrow screens
 *  (.tb-label in frost.css), so the icon and the aria-label carry it. */
export function relabel(b: HTMLElement, id: string, text: string): void {
  const label = document.createElement('span');
  label.className = 'tb-label';
  label.textContent = text;
  b.replaceChildren(icon(id), label);
  b.setAttribute('aria-label', text);
  b.title = text;
}
