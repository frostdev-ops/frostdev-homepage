// The login valley — the same terraced terrain as the splash, seen from down
// inside it. The splash gate dives into a valley; this is where you land.
// Shares the splash shaders; only camera, amplitude, and mood differ.
import * as THREE from 'three';
import { terrainVert, terrainFrag } from '../splash/shaders.ts';

const PALETTE = [0x0a1626, 0x123b66, 0x2e6db4, 0x1f8fc9, 0x5f93ab, 0x8fa6b5, 0xc4d4dc, 0xeaf6f9];
const FOG_COLOR = 0x060d18;

export function createLoginScene(canvas: HTMLCanvasElement, opts: { still?: boolean } = {}): void {
  const reduced = opts.still || matchMedia('(prefers-reduced-motion: reduce)').matches;
  const fine = matchMedia('(pointer: fine)').matches;
  const high = fine && (navigator.hardwareConcurrency || 0) >= 8;

  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: high,
      preserveDrawingBuffer: !!opts.still,
    });
  } catch {
    return; // no WebGL — the CSS ground stays
  }
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, high ? 1.75 : 1.25));
  renderer.setSize(innerWidth, innerHeight, false);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 100);
  // Lower and mistier than the splash overview — descending toward the valley.
  // (A true ground-level camera shows the terrace cliffs edge-on, where the
  // quantized steps triangulate into ugly teeth; the plates need to be read
  // from above.)
  const CAM = new THREE.Vector3(0, 5.4, 6.8);
  camera.position.copy(CAM);

  const segs = high ? [420, 260] : [260, 160];
  const geo = new THREE.PlaneGeometry(60, 40, segs[0]!, segs[1]!);
  geo.rotateX(-Math.PI / 2);

  const uniforms = {
    uTime: { value: 0 },
    uFlow: { value: 1 },
    uDetail: { value: 1 },
    uLevels: { value: 8 },
    uAmp: { value: 1.5 },
    uPalette: { value: PALETTE.map((c) => new THREE.Color(c)) },
    uFog: { value: new THREE.Color(FOG_COLOR) },
    uCam: { value: camera.position },
    // Mist closes in nearer than on the splash overview.
    uFogRange: { value: new THREE.Vector2(9, 26) },
  };
  const terrain = new THREE.Mesh(
    geo,
    new THREE.ShaderMaterial({ vertexShader: terrainVert, fragmentShader: terrainFrag, uniforms, transparent: true })
  );
  terrain.position.set(0, 0, -6);
  scene.add(terrain);

  let mx = 0;
  let my = 0;
  if (fine && !reduced) {
    addEventListener(
      'pointermove',
      (e) => {
        mx = (e.clientX / innerWidth) * 2 - 1;
        my = -((e.clientY / innerHeight) * 2 - 1);
      },
      { passive: true }
    );
  }

  let t = reduced ? 14 : 0;
  let raf = 0;
  let lastT = 0;
  let live = false;

  function step(dt: number) {
    uniforms.uTime.value = t;
    // Very slow: the valley walls quietly re-form while you type.
    uniforms.uFlow.value = 0.55;
    const target = new THREE.Vector3(
      Math.sin(t * 0.07) * 0.7 + mx * 0.5,
      CAM.y + Math.sin(t * 0.16) * 0.15 + my * 0.25,
      CAM.z
    );
    camera.position.lerp(target, reduced ? 1 : 1 - Math.exp(-4 * dt));
    camera.lookAt(0, 0.2, -7);
  }

  function render() {
    renderer.render(scene, camera);
    if (!live) {
      live = true;
      canvas.classList.add('live');
    }
  }

  function frame(now: number) {
    raf = requestAnimationFrame(frame);
    const dt = lastT ? Math.min((now - lastT) / 1000, 0.05) : 1 / 60;
    lastT = now;
    t += dt;
    step(dt);
    render();
  }

  function pause() {
    if (raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
  }
  function resume() {
    if (!raf && document.visibilityState === 'visible' && !reduced) {
      lastT = 0;
      raf = requestAnimationFrame(frame);
    }
  }

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight, false);
    if (reduced) {
      step(0);
      render();
    }
  });

  if (reduced) {
    step(0);
    render();
  } else {
    document.addEventListener('visibilitychange', () => (document.visibilityState === 'visible' ? resume() : pause()));
    resume();
  }
}
