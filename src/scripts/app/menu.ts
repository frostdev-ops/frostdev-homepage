// The context menu — one floating `.ctx-menu` at a time, viewport-clamped.
// Shared by the ward/grid menus (edit.ts) and the page tabs (pages.ts).

import { icon } from './icon.ts';
import { el } from './dom.ts';

let menuEl: HTMLElement | null = null;
export function closeMenu(): void {
  menuEl?.remove();
  menuEl = null;
}

/** `id` is a semantic icon id (lib/icon-names.ts) — the menu follows the theme's icon set like the wards do. */
export function menuItem(id: string, label: string, fn: () => void, danger = false): HTMLElement {
  const b = el('button') as HTMLButtonElement;
  b.type = 'button';
  b.setAttribute('role', 'menuitem');
  if (danger) b.dataset.danger = '1';
  b.append(icon(id), el('span', undefined, label));
  b.addEventListener('click', () => {
    closeMenu();
    fn();
  });
  return b;
}

export function openMenu(x: number, y: number, build: (m: HTMLElement) => void): void {
  closeMenu();
  const m = el('div', 'ctx-menu');
  m.setAttribute('role', 'menu');
  build(m);
  document.body.append(m);
  const r = m.getBoundingClientRect();
  m.style.left = `${Math.max(8, Math.min(x, innerWidth - r.width - 8))}px`;
  m.style.top = `${Math.max(8, Math.min(y, innerHeight - r.height - 8))}px`;
  menuEl = m;
  m.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
}

// Close paths: outside click, Escape, any scroll, a resize.
document.addEventListener('click', (e) => {
  if (menuEl && !menuEl.contains(e.target as Node)) closeMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeMenu();
});
window.addEventListener('scroll', closeMenu, { passive: true, capture: true });
window.addEventListener('resize', closeMenu);
