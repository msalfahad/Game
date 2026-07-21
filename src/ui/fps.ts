// Always-on FPS meter. Runs its own requestAnimationFrame loop (independent of
// the match engine) so it shows a live frame-rate on EVERY screen — menus,
// offline matches and online matches alike. Colour-coded so lag is obvious at a
// glance: green = smooth, yellow = choppy, red = bad. Sits in the top-left
// corner, out of the way of the HUD.

let el: HTMLElement | null = null;
let last = performance.now();
let frames = 0;
let acc = 0;
let fps = 60;

export function startFpsMeter() {
  if (el) return;
  el = document.createElement('div');
  el.id = 'fpsMeter';
  el.style.cssText =
    'position:fixed;top:6px;left:6px;z-index:60;pointer-events:none;' +
    'font-family:Bungee,system-ui,sans-serif;font-size:11px;font-weight:700;' +
    'padding:3px 7px;border-radius:8px;color:#08240f;background:#3bd45a;' +
    'box-shadow:0 2px 0 rgba(0,0,0,.35);letter-spacing:.5px;min-width:44px;text-align:center;';
  el.textContent = '60 FPS';
  document.body.appendChild(el);
  requestAnimationFrame(loop);
}

function loop(now: number) {
  const dt = now - last;
  last = now;
  acc += dt;
  frames++;
  // Refresh the readout ~3x a second so it's readable, not flickery.
  if (acc >= 320) {
    fps = Math.round((frames * 1000) / acc);
    frames = 0;
    acc = 0;
    render();
  }
  requestAnimationFrame(loop);
}

function render() {
  if (!el) return;
  // Green ≥50, yellow 30–49, red <30.
  const bg = fps >= 50 ? '#3bd45a' : fps >= 30 ? '#ffd23f' : '#ff4d4d';
  const fg = fps >= 30 ? '#08240f' : '#3a0808';
  el.style.background = bg;
  el.style.color = fg;
  el.textContent = `${fps} FPS`;
}
