import * as THREE from 'three';
import type { FamilyDef, GameDef } from '../data/maps';
import type { SurfaceKind } from '../data/surfaces';
import { auroraSky, gradientSky, styledFloor } from './textures';

// Builds the themed arena for a game: sky, fog, lights, ground, floor (square
// or circle), neon trim, per-family decorative props, and ambient particles.

export interface World {
  floorMesh: THREE.Mesh;
  ringMesh: THREE.Mesh | null; // circle arenas expose their trim ring (pushout shrinks it)
  halfSize: number;
  surfaceAt: (x: number, z: number) => SurfaceKind;
  tick: (dt: number) => void;
}

// Radial alpha for the ground: opaque around the arena, fading to transparent
// toward the rim so the plane blends into the scenic background.
function groundFade(halfSize: number): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  const R = 128;
  const inner = Math.min(0.4, (halfSize * 2.4) / 250) * R; // solid out to here
  const outer = Math.min(0.98, (halfSize * 5.5) / 250) * R; // gone by here
  const grd = g.createRadialGradient(128, 128, inner, 128, 128, outer);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 256, 256);
  return new THREE.CanvasTexture(c);
}

export function buildWorld(
  scene: THREE.Scene,
  family: FamilyDef,
  game: GameDef,
  halfSize: number,
  rect?: { w: number; l: number }, // rectangular arenas (the climb corridor)
): World {
  const t = family.theme;
  const style = family.style;
  // Night maze (Night Heist): a dark, moonlit theme where the map and the
  // background match — torch-lit robbers vs a cop who sees in the dark.
  const night = game.mechanic === 'maze';

  // The family's generated arena key art fills the whole background behind the
  // 3D arena (the immersive "sky behind the rink" look). Flat theme colour is
  // the fallback until the image loads, or if a family has no art.
  scene.background = new THREE.Color(night ? 0x070b18 : t.skyBot);
  const loader = new THREE.TextureLoader();
  const applyBg = (tex: THREE.Texture) => {
    tex.colorSpace = THREE.SRGBColorSpace;
    scene.background = tex;
    // Brighten the backdrop so the scenic art reads clearly through the
    // cinematic grade (otherwise the tone curve + vignette crush it dark).
    scene.backgroundIntensity = 2.6;
  };
  // The croc raft lives in the sky family but wants a clean forest-river look —
  // keep a flat sky-blue behind it instead of the bright cloud keyart (which
  // blows out the scene).
  const flatSky = game.mechanic === 'raft' || game.mechanic === 'coaster' || game.mechanic === 'sprint' || game.mechanic === 'foosball';
  if (flatSky) scene.background = new THREE.Color(
    game.mechanic === 'sprint' ? 0x8fc4ec : game.mechanic === 'foosball' ? 0x0f2415 : 0x6fb0e6,
  );
  // Prefer a portrait, phone-composed background (maps/<id>-bg.png) so the
  // scene fills a tall screen without cropping out the sky; fall back to the
  // landscape card art, then to the flat theme colour. Night keeps the flat
  // dark sky so map + background read as one continuous night.
  if (!night && !flatSky) loader.load(
    `maps/${family.id}-bg.png`,
    applyBg,
    undefined,
    () => loader.load(`maps/${family.id}.webp`, applyBg, undefined, () => {}),
  );
  scene.fog = new THREE.Fog(new THREE.Color(night ? 0x070b18 : t.fog).getHex(), halfSize * (night ? 1.6 : 3.0), halfSize * (night ? 4.5 : 7.5));
  void auroraSky; void gradientSky; // retained for the single-file/legacy path

  scene.add(new THREE.AmbientLight(night ? 0x2a3450 : t.light, night ? 0.18 : 0.75));
  const sun = new THREE.DirectionalLight(night ? 0x5a6a9a : t.light, night ? 0.2 : 0.9);
  sun.position.set(24, 95, -12);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048); // crisper contact shadows for the 3D heroes
  sun.shadow.camera.left = -halfSize * 1.6;
  sun.shadow.camera.right = halfSize * 1.6;
  sun.shadow.camera.top = halfSize * 1.6;
  sun.shadow.camera.bottom = -halfSize * 1.6;
  scene.add(sun);
  const rim = new THREE.PointLight(t.trim, night ? 0.15 : 0.6, 300);
  rim.position.set(0, 40, -40);
  scene.add(rim);

  // Surrounding ground plane, radially FADED to transparent at the rim so the
  // arena dissolves into the scenic background instead of sitting on a hard
  // flat disc — keeps map + backdrop reading as one image.
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(500, 500),
    new THREE.MeshStandardMaterial({
      color: night ? 0x0a0e1e : new THREE.Color(t.ground).getHex(),
      roughness: 1,
      emissive: style === 'lava' ? 0x2a0c04 : 0x000000,
      alphaMap: groundFade(halfSize),
      transparent: true,
      depthWrite: false,
    }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -2;
  ground.renderOrder = -1;
  ground.receiveShadow = true;
  scene.add(ground);

  // Arena floor. Night maze uses a plain dark ground so the torch beams read.
  const ftex = styledFloor(style);
  const shiny = style === 'ice' || style === 'sky';
  const fmat = new THREE.MeshStandardMaterial({
    map: night ? null : ftex,
    color: night ? 0x2c3550 : 0xffffff,
    roughness: night ? 1 : shiny ? 0.6 : 0.85,
    metalness: shiny && !night ? 0.1 : 0.05,
    emissive: style === 'lava' ? 0x3a1008 : 0x000000,
    emissiveIntensity: style === 'lava' ? 0.6 : 0,
  });

  // Real tiling ice PBR maps are not generated yet; when they land in
  // public/textures/, wire them here with an async loader + onLoad swap
  // (assigning a TextureLoader result that 404s renders the floor black).

  let floorMesh: THREE.Mesh;
  let ringMesh: THREE.Mesh | null = null;
  const trimMat = new THREE.MeshBasicMaterial({ color: t.trim });
  if (game.shape === 'circle') {
    floorMesh = new THREE.Mesh(new THREE.CircleGeometry(halfSize, 64), fmat);
    ringMesh = new THREE.Mesh(new THREE.TorusGeometry(halfSize, 0.7, 8, 80), trimMat);
    ringMesh.rotation.x = -Math.PI / 2;
    ringMesh.position.y = 0.4;
    scene.add(ringMesh);
  } else if (game.mechanic === 'boat' || game.mechanic === 'raft') {
    // Boat race / croc raft: a big forest floor covering the whole winding
    // river course (the module lays the river + banks on top). No perimeter
    // trim bars — the course isn't a bounded arena. The raft lives in the sky
    // family, so force a forest-green ground under it regardless of theme.
    // The boat race lays out a long winding course, so its floor must be big.
    const fw = halfSize * (game.mechanic === 'boat' ? 9 : 3.2);
    const rmat = game.mechanic === 'raft'
      ? new THREE.MeshStandardMaterial({ color: 0x3f7a34, roughness: 1 })
      : new THREE.MeshStandardMaterial({ color: 0x3f7a34, roughness: 1 });
    floorMesh = new THREE.Mesh(new THREE.PlaneGeometry(fw * 2, fw * 2), rmat);
  } else if (game.mechanic === 'sprint') {
    // Olympic Sprint lays its own stadium (track + stands) on top — the world
    // floor is just a big grass base under everything, no perimeter trim bars.
    floorMesh = new THREE.Mesh(new THREE.PlaneGeometry(320, 320),
      new THREE.MeshStandardMaterial({ color: 0x2f6a34, roughness: 1 }));
  } else if (game.mechanic === 'foosball') {
    // Foot Brawl lays its own pitch on top; keep a plain dark surround so only
    // the pitch reads (no forest props / trim bars).
    floorMesh = new THREE.Mesh(new THREE.PlaneGeometry(200, 200),
      new THREE.MeshStandardMaterial({ color: 0x123018, roughness: 1 }));
  } else {
    const fw = rect ? rect.w : halfSize;
    const fl = rect ? rect.l : halfSize;
    floorMesh = new THREE.Mesh(new THREE.PlaneGeometry(fw * 2, fl * 2), fmat);
    ([[0, fl], [0, -fl], [fw, 0], [-fw, 0]] as const).forEach((p, i) => {
      const horiz = i < 2;
      const bar = new THREE.Mesh(new THREE.BoxGeometry(horiz ? fw * 2 : 1.4, 1.4, horiz ? 1.4 : fl * 2), trimMat);
      bar.position.set(p[0], 0.5, p[1]);
      scene.add(bar);
    });
  }
  floorMesh.rotation.x = -Math.PI / 2;
  floorMesh.receiveShadow = true;
  scene.add(floorMesh);

  // Goal games skip the tall perimeter props (they blocked the near wall);
  // rectangular corridors skip them too (the ring layout doesn't fit); Musical
  // Chairs wants a clean ring, and its tight framing put a prop in the
  // foreground.
  if (game.mechanic !== 'goal' && game.mechanic !== 'musicalchairs' && game.mechanic !== 'chase' && game.mechanic !== 'kart' && game.mechanic !== 'maze' && game.mechanic !== 'lavafloor' && game.mechanic !== 'boat' && game.mechanic !== 'raft' && game.mechanic !== 'sprint' && game.mechanic !== 'foosball' && !rect) buildProps(scene, family, halfSize, trimMat);
  // Floor Is Lava: a bright, warm fill so the map + backdrop read as one glowing scene.
  if (game.mechanic === 'lavafloor') { scene.add(new THREE.AmbientLight(0xffd8a8, 1.5)); scene.fog = new THREE.Fog(new THREE.Color(0xff7a2e).getHex(), halfSize * 3.5, halfSize * 9); }
  // The Sprint stadium has its own sky/crowd; skip the family ambient particles
  // (bubbles floating over an athletics track look out of place).
  const ambientPts = (game.mechanic === 'sprint' || game.mechanic === 'foosball') ? null : buildAmbient(scene, family, halfSize);

  const surfaceAt = (_x: number, _z: number): SurfaceKind => family.surface;

  return {
    floorMesh,
    ringMesh,
    halfSize,
    surfaceAt,
    tick(dt: number) {
      tickAmbient(ambientPts, family, dt);
    },
  };
}

// --- props ------------------------------------------------------------------
function buildProps(scene: THREE.Scene, family: FamilyDef, half: number, trimMat: THREE.MeshBasicMaterial) {
  const style = family.style;
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x5a3a22, roughness: 1 });
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const rad = half * 1.5;
    const h = 14 + Math.sin(i * 3) * 5;
    const px = Math.cos(a) * rad, pz = Math.sin(a) * rad;

    if (style === 'forest') {
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(1.4, 2, h * 0.6, 7), trunkMat);
      trunk.position.set(px, h * 0.3 - 2, pz); trunk.castShadow = true; scene.add(trunk);
      const canopy = new THREE.Mesh(new THREE.ConeGeometry(6, h * 0.8, 8),
        new THREE.MeshStandardMaterial({ color: 0x3e8a44, roughness: 1 }));
      canopy.position.set(px, h * 0.75 - 2, pz); canopy.castShadow = true; scene.add(canopy);
    } else if (style === 'pirate') {
      // masts with sails
      const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.2, h, 7), trunkMat);
      mast.position.set(px, h / 2 - 2, pz); mast.castShadow = true; scene.add(mast);
      if (i % 2 === 0) {
        const sail = new THREE.Mesh(new THREE.ConeGeometry(4.5, h * 0.55, 4),
          new THREE.MeshStandardMaterial({ color: 0xf0ead8, roughness: 0.9 }));
        sail.position.set(px, h * 0.62 - 2, pz); scene.add(sail);
      }
    } else if (style === 'sky') {
      // floating cloud puffs
      const cloud = new THREE.Mesh(new THREE.SphereGeometry(4 + (i % 3), 10, 10),
        new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, transparent: true, opacity: 0.85 }));
      cloud.position.set(px, 4 + Math.sin(i * 2) * 6, pz); scene.add(cloud);
    } else if (style === 'desert') {
      if (i % 3 === 0) {
        // palm: trunk + fan of cones
        const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.3, h * 0.7, 7), trunkMat);
        trunk.position.set(px, h * 0.35 - 2, pz); trunk.castShadow = true; scene.add(trunk);
        const fronds = new THREE.Mesh(new THREE.ConeGeometry(5, 3, 6),
          new THREE.MeshStandardMaterial({ color: 0x4e9a4a, roughness: 1 }));
        fronds.position.set(px, h * 0.7 - 1, pz); scene.add(fronds);
      } else {
        const pillar = new THREE.Mesh(new THREE.CylinderGeometry(2, 2.6, h, 8),
          new THREE.MeshStandardMaterial({ color: 0xc49a5a, roughness: 0.9 }));
        pillar.position.set(px, h / 2 - 2, pz); pillar.castShadow = true; scene.add(pillar);
        const cap = new THREE.Mesh(new THREE.SphereGeometry(1.4, 10, 10), trimMat);
        cap.position.set(px, h - 2, pz); scene.add(cap);
      }
    } else if (style === 'mech') {
      const pylon = new THREE.Mesh(new THREE.BoxGeometry(3, h, 3),
        new THREE.MeshStandardMaterial({ color: 0x2a323e, roughness: 0.6, metalness: 0.6 }));
      pylon.position.set(px, h / 2 - 2, pz); pylon.castShadow = true; scene.add(pylon);
      const cap = new THREE.Mesh(new THREE.SphereGeometry(1.2, 10, 10), trimMat);
      cap.position.set(px, h - 2, pz); scene.add(cap);
    } else {
      // ice / lava / neon: crystal or rock spires
      const isIce = style === 'ice';
      const mat = new THREE.MeshStandardMaterial({
        color: isIce ? 0x6ab8e8 : style === 'lava' ? 0x2a1512 : 0x2a3050,
        roughness: isIce ? 0.2 : 0.9,
        metalness: isIce ? 0.3 : 0,
        transparent: isIce,
        opacity: isIce ? 0.85 : 1,
        emissive: isIce ? 0x1a4a7a : style === 'lava' ? 0x3a1206 : 0x000000,
      });
      const spire = new THREE.Mesh(
        isIce || style === 'lava' ? new THREE.ConeGeometry(2.4, h, 5) : new THREE.CylinderGeometry(2, 2.6, h, 8),
        mat,
      );
      spire.position.set(px, h / 2 - 2, pz); spire.castShadow = true; scene.add(spire);
      const cap = new THREE.Mesh(new THREE.SphereGeometry(1.4, 10, 10), trimMat);
      cap.position.set(px, h - 2, pz); scene.add(cap);
    }
  }
}

// --- ambient particles ------------------------------------------------------
function buildAmbient(scene: THREE.Scene, family: FamilyDef, half: number): THREE.Points | null {
  const amb = family.theme.ambient;
  if (amb === 'none') return null;
  const n = amb === 'stars' ? 120 : 70;
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    pos[i * 3] = (Math.random() - 0.5) * half * 3;
    pos[i * 3 + 1] = Math.random() * 60 + (amb === 'stars' ? 20 : 2);
    pos[i * 3 + 2] = (Math.random() - 0.5) * half * 3;
  }
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const conf: Record<string, [number, number]> = {
    snow: [0xffffff, 1.2], embers: [0xff7a2e, 1.0], sand: [0xffd79a, 0.8],
    leaves: [0x9ad85a, 1.4], stars: [0xffffff, 1.2], bubbles: [0xbfefff, 1.0],
  };
  const [col, size] = conf[amb] ?? [0xffffff, 1.2];
  const mat = new THREE.PointsMaterial({ color: col, size, transparent: true, opacity: 0.8, depthWrite: false });
  const pts = new THREE.Points(geo, mat);
  scene.add(pts);
  return pts;
}

function tickAmbient(pts: THREE.Points | null, family: FamilyDef, dt: number) {
  if (!pts) return;
  const amb = family.theme.ambient;
  if (amb === 'stars') return;
  const arr = pts.geometry.attributes.position.array as Float32Array;
  for (let i = 0; i < arr.length; i += 3) {
    if (amb === 'embers' || amb === 'bubbles') {
      arr[i + 1] += dt * (amb === 'embers' ? 5 : 6);
      if (amb === 'embers') arr[i] += Math.sin(arr[i + 1]) * dt;
      if (arr[i + 1] > 60) arr[i + 1] = 2;
    } else {
      arr[i + 1] -= dt * 6;
      arr[i] += Math.sin(arr[i + 1] * 0.1) * dt * 2;
      if (arr[i + 1] < 2) arr[i + 1] = 60;
    }
  }
  pts.geometry.attributes.position.needsUpdate = true;
}
