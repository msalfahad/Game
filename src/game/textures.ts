import * as THREE from 'three';
import type { FloorStyle } from '../data/maps';

// Procedural canvas textures — original art generated at runtime (SPEC
// sections 6 & 16). One floor per family style, plus skies and the Surface
// Lab quadrant floor.

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

// --- shared helpers ---------------------------------------------------------
function shade(hex: string, d: number): string {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) + d * 255, gg = ((n >> 8) & 255) + d * 255, b = (n & 255) + d * 255;
  r = Math.max(0, Math.min(255, r)); gg = Math.max(0, Math.min(255, gg)); b = Math.max(0, Math.min(255, b));
  return `rgb(${r | 0},${gg | 0},${b | 0})`;
}

function stoneTiles(g: CanvasRenderingContext2D, base: string, grout: string, jitter: number) {
  g.fillStyle = base; g.fillRect(0, 0, 512, 512);
  const s = 64;
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    g.fillStyle = shade(base, (Math.random() - 0.5) * jitter);
    g.fillRect(x * s + 2, y * s + 2, s - 4, s - 4);
  }
  g.strokeStyle = grout; g.lineWidth = 3;
  for (let i = 0; i <= 8; i++) {
    g.beginPath(); g.moveTo(i * s, 0); g.lineTo(i * s, 512); g.stroke();
    g.beginPath(); g.moveTo(0, i * s); g.lineTo(512, i * s); g.stroke();
  }
}

function star(g: CanvasRenderingContext2D, cx: number, cy: number, pts: number, r1: number, r2: number, col: string, glow: string) {
  g.save(); g.translate(cx, cy); g.fillStyle = col; g.shadowColor = glow; g.shadowBlur = 18;
  g.beginPath();
  for (let i = 0; i < pts * 2; i++) {
    const a = (i / (pts * 2)) * Math.PI * 2, r = i % 2 ? r2 : r1;
    i ? g.lineTo(Math.cos(a) * r, Math.sin(a) * r) : g.moveTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  g.closePath(); g.fill(); g.restore();
}

// --- floors -----------------------------------------------------------------
export function iceFloor(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(256, 256, 40, 256, 256, 300);
  grd.addColorStop(0, '#AED6F5'); grd.addColorStop(0.6, '#7EB4E0'); grd.addColorStop(1, '#4E82C0');
  g.fillStyle = grd; g.fillRect(0, 0, 512, 512);
  g.strokeStyle = 'rgba(255,255,255,.28)'; g.lineWidth = 1.5;
  for (let i = 0; i < 40; i++) {
    g.beginPath();
    let x = Math.random() * 512, y = Math.random() * 512; g.moveTo(x, y);
    for (let j = 0; j < 3; j++) { x += (Math.random() - 0.5) * 90; y += (Math.random() - 0.5) * 90; g.lineTo(x, y); }
    g.stroke();
  }
  g.strokeStyle = 'rgba(255,255,255,.5)'; g.lineWidth = 3;
  ([[140, 140], [372, 140], [140, 372], [372, 372]] as const).forEach((p) => {
    g.beginPath(); g.arc(p[0], p[1], 34, 0, 7); g.stroke();
    g.beginPath(); g.arc(p[0], p[1], 4, 0, 7); g.fillStyle = 'rgba(255,255,255,.6)'; g.fill();
  });
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

export function styledFloor(style: FloorStyle): THREE.CanvasTexture {
  if (style === 'ice') return iceFloor();
  if (style === 'greybox') return quadrantFloor();
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const g = c.getContext('2d')!;

  if (style === 'lava') {
    stoneTiles(g, '#4A3038', 'rgba(0,0,0,.5)', 0.06);
    g.shadowColor = '#FF8030'; g.shadowBlur = 10; g.lineWidth = 4;
    for (let i = 0; i < 14; i++) {
      g.beginPath();
      let x = Math.random() * 512, y = Math.random() * 512; g.moveTo(x, y);
      for (let j = 0; j < 3; j++) { x += (Math.random() - 0.5) * 90; y += (Math.random() - 0.5) * 90; g.lineTo(x, y); }
      g.strokeStyle = Math.random() < 0.5 ? '#FFB020' : '#FF5E2E'; g.stroke();
    }
    g.shadowBlur = 0;
    star(g, 256, 256, 8, 70, 26, '#FF7A2E', '#FFB050');
    star(g, 256, 256, 8, 34, 12, '#FFD23F', '#FFE080');
  } else if (style === 'desert') {
    stoneTiles(g, '#C9A05A', 'rgba(120,90,45,.5)', 0.05);
    g.strokeStyle = 'rgba(150,110,55,.5)'; g.lineWidth = 4;
    [200, 150, 100].forEach((r) => { g.beginPath(); g.arc(256, 256, r, 0, 7); g.stroke(); });
    star(g, 256, 256, 8, 64, 22, '#8A6A38', '#C9A860');
    g.fillStyle = '#E8C888'; g.beginPath(); g.arc(256, 256, 14, 0, 7); g.fill();
  } else if (style === 'forest') {
    stoneTiles(g, '#4E7A4A', 'rgba(30,55,30,.55)', 0.07);
    g.fillStyle = 'rgba(90,168,94,.4)';
    for (let i = 0; i < 24; i++) {
      g.beginPath();
      g.ellipse(Math.random() * 512, Math.random() * 512, Math.random() * 22 + 8, Math.random() * 16 + 6, Math.random(), 0, 7);
      g.fill();
    }
    g.save(); g.translate(256, 256);
    g.strokeStyle = '#B6FF6A'; g.shadowColor = '#B6FF2E'; g.shadowBlur = 14; g.lineWidth = 5;
    g.beginPath(); g.arc(0, 0, 60, 0, 7); g.stroke();
    for (let i = 0; i < 6; i++) {
      g.rotate(Math.PI / 3);
      g.beginPath(); g.moveTo(0, -60); g.lineTo(14, -40); g.lineTo(-14, -40); g.closePath(); g.stroke();
    }
    g.beginPath(); g.arc(0, 0, 20, 0, 7); g.stroke(); g.restore();
  } else if (style === 'sky') {
    const grd = g.createRadialGradient(256, 256, 60, 256, 256, 330);
    grd.addColorStop(0, '#EAF6FF'); grd.addColorStop(0.7, '#BFE0F8'); grd.addColorStop(1, '#8FBCE8');
    g.fillStyle = grd; g.fillRect(0, 0, 512, 512);
    g.fillStyle = 'rgba(255,255,255,.55)';
    for (let i = 0; i < 20; i++) {
      const x = Math.random() * 512, y = Math.random() * 512, r = Math.random() * 34 + 16;
      g.beginPath(); g.ellipse(x, y, r, r * 0.55, 0, 0, 7); g.fill();
    }
    g.strokeStyle = 'rgba(255,255,255,.7)'; g.lineWidth = 5;
    g.beginPath(); g.arc(256, 256, 90, 0, 7); g.stroke();
    g.strokeStyle = 'rgba(130,180,240,.8)'; g.lineWidth = 8; g.strokeRect(14, 14, 484, 484);
  } else if (style === 'mech') {
    stoneTiles(g, '#3A424E', 'rgba(0,0,0,.55)', 0.05);
    // rivets
    g.fillStyle = 'rgba(200,220,235,.35)';
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      g.beginPath(); g.arc(x * 64 + 10, y * 64 + 10, 3, 0, 7); g.fill();
      g.beginPath(); g.arc(x * 64 + 54, y * 64 + 54, 3, 0, 7); g.fill();
    }
    // glow conduits
    g.strokeStyle = 'rgba(46,242,255,.5)'; g.shadowColor = '#2EF2FF'; g.shadowBlur = 8; g.lineWidth = 4;
    g.beginPath(); g.moveTo(0, 128); g.lineTo(512, 128); g.stroke();
    g.beginPath(); g.moveTo(0, 384); g.lineTo(512, 384); g.stroke();
    g.shadowBlur = 0;
    // hazard stripe border
    g.save();
    for (let i = 0; i < 64; i++) {
      g.fillStyle = i % 2 ? '#F5C518' : '#1A1A1A';
      const t = i * 32;
      if (t < 512) { g.fillRect(t, 0, 16, 14); g.fillRect(t, 498, 16, 14); g.fillRect(0, t, 14, 16); g.fillRect(498, t, 14, 16); }
    }
    g.restore();
  } else if (style === 'pirate') {
    // wooden planks
    g.fillStyle = '#8A5A2E'; g.fillRect(0, 0, 512, 512);
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 4; x++) {
        g.fillStyle = shade('#8A5A2E', (Math.random() - 0.5) * 0.14);
        g.fillRect(x * 128 + (y % 2 ? 64 : 0) - 64, y * 64 + 2, 126, 60);
      }
    }
    g.strokeStyle = 'rgba(40,20,8,.6)'; g.lineWidth = 3;
    for (let y = 0; y <= 8; y++) { g.beginPath(); g.moveTo(0, y * 64); g.lineTo(512, y * 64); g.stroke(); }
    g.fillStyle = 'rgba(30,16,6,.7)';
    for (let i = 0; i < 60; i++) g.fillRect(Math.random() * 512, Math.random() * 512, 3, 3);
    // compass rose
    star(g, 256, 256, 4, 80, 24, 'rgba(255,210,63,.75)', '#FFE08A');
    star(g, 256, 256, 4, 44, 14, 'rgba(120,70,25,.9)', '#8A5A2E');
  } else {
    // neon (classic) checkerboard
    g.fillStyle = '#2E3868'; g.fillRect(0, 0, 512, 512);
    g.fillStyle = '#1E2650';
    const s = 64;
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) if ((x + y) % 2) g.fillRect(x * s, y * s, s, s);
    g.strokeStyle = 'rgba(46,242,255,.28)'; g.lineWidth = 2;
    for (let i = 0; i <= 8; i++) {
      g.beginPath(); g.moveTo(i * s, 0); g.lineTo(i * s, 512); g.stroke();
      g.beginPath(); g.moveTo(0, i * s); g.lineTo(512, i * s); g.stroke();
    }
    star(g, 256, 256, 5, 60, 24, 'rgba(46,242,255,.5)', '#2EF2FF');
  }
  return new THREE.CanvasTexture(c);
}

/** Surface Lab floor: four labelled quadrants + conveyor strip. */
export function quadrantFloor(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const g = c.getContext('2d')!;
  const quads: [number, number, string, string][] = [
    [0, 0, '#3A4048', 'METAL'],
    [256, 0, '#AED6F5', 'ICE'],
    [0, 256, '#5A4432', 'MUD'],
    [256, 256, '#C9A05A', 'SAND'],
  ];
  for (const [qx, qy, col, label] of quads) {
    g.fillStyle = col; g.fillRect(qx, qy, 256, 256);
    g.fillStyle = 'rgba(0,0,0,.45)'; g.font = 'bold 40px sans-serif';
    g.textAlign = 'center'; g.fillText(label, qx + 128, qy + 138);
  }
  g.fillStyle = '#2A2E44'; g.fillRect(0, 226, 512, 60);
  g.fillStyle = '#FFB020';
  for (let x = 0; x < 512; x += 40) {
    g.beginPath(); g.moveTo(x, 236); g.lineTo(x + 20, 256); g.lineTo(x, 276); g.closePath(); g.fill();
  }
  g.strokeStyle = 'rgba(255,255,255,.25)'; g.lineWidth = 3; g.strokeRect(3, 3, 506, 506);
  return new THREE.CanvasTexture(c);
}
