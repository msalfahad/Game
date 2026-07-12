import * as THREE from 'three';

// Procedural canvas textures — original art, generated at runtime (SPEC
// sections 6 & 16). Aurora sky + cracked-ice rink for Frostbite; a labelled
// quadrant floor for the Surface Lab greybox.

export function auroraSky(top: string, bot: string): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 256;
  const g = c.getContext('2d')!;
  const grd = g.createLinearGradient(0, 0, 0, 256);
  grd.addColorStop(0, top); grd.addColorStop(1, bot);
  g.fillStyle = grd; g.fillRect(0, 0, 64, 256);
  const bands = ['rgba(80,255,180,.30)', 'rgba(150,120,255,.24)', 'rgba(90,220,255,.22)'];
  for (let b = 0; b < 3; b++) {
    const y = 30 + b * 26;
    g.strokeStyle = bands[b]; g.lineWidth = 10; g.beginPath();
    for (let x = 0; x <= 64; x += 4) {
      const yy = y + Math.sin(x / 10 + b) * 10;
      x ? g.lineTo(x, yy) : g.moveTo(x, yy);
    }
    g.stroke();
  }
  g.fillStyle = 'rgba(255,255,255,.7)';
  for (let i = 0; i < 40; i++) g.fillRect(Math.random() * 64, Math.random() * 120, 1.5, 1.5);
  return new THREE.CanvasTexture(c);
}

export function gradientSky(top: string, bot: string): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 16; c.height = 256;
  const g = c.getContext('2d')!;
  const grd = g.createLinearGradient(0, 0, 0, 256);
  grd.addColorStop(0, top); grd.addColorStop(1, bot);
  g.fillStyle = grd; g.fillRect(0, 0, 16, 256);
  return new THREE.CanvasTexture(c);
}

export function iceFloor(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(256, 256, 40, 256, 256, 300);
  grd.addColorStop(0, '#AED6F5'); grd.addColorStop(0.6, '#7EB4E0'); grd.addColorStop(1, '#4E82C0');
  g.fillStyle = grd; g.fillRect(0, 0, 512, 512);
  // cracks
  g.strokeStyle = 'rgba(255,255,255,.28)'; g.lineWidth = 1.5;
  for (let i = 0; i < 40; i++) {
    g.beginPath();
    let x = Math.random() * 512, y = Math.random() * 512; g.moveTo(x, y);
    for (let j = 0; j < 3; j++) { x += (Math.random() - 0.5) * 90; y += (Math.random() - 0.5) * 90; g.lineTo(x, y); }
    g.stroke();
  }
  // face-off circles
  g.strokeStyle = 'rgba(255,255,255,.5)'; g.lineWidth = 3;
  ([[140, 140], [372, 140], [140, 372], [372, 372]] as const).forEach((p) => {
    g.beginPath(); g.arc(p[0], p[1], 34, 0, 7); g.stroke();
    g.beginPath(); g.arc(p[0], p[1], 4, 0, 7); g.fillStyle = 'rgba(255,255,255,.6)'; g.fill();
  });
  // center snowflake
  g.save(); g.translate(256, 256);
  g.strokeStyle = 'rgba(255,255,255,.75)'; g.lineWidth = 4; g.lineCap = 'round';
  for (let i = 0; i < 6; i++) {
    g.rotate(Math.PI / 3);
    g.beginPath(); g.moveTo(0, 0); g.lineTo(0, -90); g.stroke();
    g.beginPath();
    g.moveTo(0, -45); g.lineTo(-20, -62); g.moveTo(0, -45); g.lineTo(20, -62);
    g.moveTo(0, -72); g.lineTo(-16, -86); g.moveTo(0, -72); g.lineTo(16, -86); g.stroke();
  }
  g.restore();
  g.strokeStyle = 'rgba(255,255,255,.35)'; g.lineWidth = 6; g.strokeRect(24, 24, 464, 464);
  return new THREE.CanvasTexture(c);
}

/**
 * Surface Lab floor: four labelled quadrants (metal / ice / mud / sand) plus a
 * conveyor strip across the middle. Layout matches surfaceAt() in world.ts.
 */
export function quadrantFloor(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const g = c.getContext('2d')!;
  const quads: [number, number, string, string][] = [
    [0, 0, '#3A4048', 'METAL'], // top-left  (-x,-z)
    [256, 0, '#AED6F5', 'ICE'], // top-right (+x,-z)
    [0, 256, '#5A4432', 'MUD'], // bot-left  (-x,+z)
    [256, 256, '#C9A05A', 'SAND'], // bot-right (+x,+z)
  ];
  for (const [qx, qy, col, label] of quads) {
    g.fillStyle = col; g.fillRect(qx, qy, 256, 256);
    g.fillStyle = 'rgba(0,0,0,.45)'; g.font = 'bold 40px sans-serif';
    g.textAlign = 'center'; g.fillText(label, qx + 128, qy + 138);
  }
  // conveyor strip across the horizontal middle
  g.fillStyle = '#2A2E44'; g.fillRect(0, 226, 512, 60);
  g.fillStyle = '#FFB020';
  for (let x = 0; x < 512; x += 40) { g.beginPath(); g.moveTo(x, 236); g.lineTo(x + 20, 256); g.lineTo(x, 276); g.closePath(); g.fill(); }
  g.strokeStyle = 'rgba(255,255,255,.25)'; g.lineWidth = 3; g.strokeRect(3, 3, 506, 506);
  return new THREE.CanvasTexture(c);
}
