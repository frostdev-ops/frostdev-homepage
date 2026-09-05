// Login entry — three arrives lazily, the form never waits on it.
const canvas = document.getElementById('login-canvas') as HTMLCanvasElement | null;
const still = new URLSearchParams(location.search).has('still');

function boot() {
  if (!canvas || canvas.dataset.booted) return;
  canvas.dataset.booted = '1';
  import('./scene.ts')
    .then((m) => m.createLoginScene(canvas, { still }))
    .catch(() => {});
}

if ('requestIdleCallback' in window) requestIdleCallback(boot);
else setTimeout(boot, 1);
addEventListener('pointermove', boot, { once: true, passive: true });
