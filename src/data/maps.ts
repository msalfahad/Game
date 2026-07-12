import type { SurfaceKind } from './surfaces';

// A map family = shared skybox / floor / trim-light color / ambient particle
// set + a hazard set, with difficulty ramping 1->4 (Learn, Adapt, Master,
// Survive). This file defines the Frostbite family (SPEC sections 1, 6) as the
// first family built end-to-end, plus a neutral greybox "Surface Lab" used to
// exercise the movement + surface systems.

export type HazardKind = 'blizzard' | 'icicles' | 'boulders' | 'cracks';

export interface ThemeColors {
  skyTop: string;
  skyBot: string;
  fog: string;
  ground: string; // surrounding ground plane
  trim: number; // neon trim / rim light color
  light: number; // ambient + sun tint
  ambient: 'snow' | 'none';
}

export type ArenaShape = 'square' | 'circle';

export interface MapDef {
  id: string;
  family: string;
  name: string;
  tier: 1 | 2 | 3 | 4; // Learn / Adapt / Master / Survive
  tierName: string;
  shape: ArenaShape;
  surface: SurfaceKind;
  theme: ThemeColors;
  hazards: HazardKind[];
  blurb: string;
}

const FROST_THEME: ThemeColors = {
  skyTop: '#243A7E',
  skyBot: '#0A1230',
  fog: '#1E2E5E',
  ground: '#12203E',
  trim: 0x9ae8ff,
  light: 0xd8ecff,
  ambient: 'snow',
};

// Frostbite Arena family — ice surface, aurora sky, escalating winter hazards.
export const FROSTBITE_MAPS: MapDef[] = [
  {
    id: 'frost-1',
    family: 'Frostbite Arena',
    name: 'Frozen Rink',
    tier: 1,
    tierName: 'Learn',
    shape: 'square',
    surface: 'ice',
    theme: FROST_THEME,
    hazards: [],
    blurb: 'A clean sheet of ice. Learn the slide.',
  },
  {
    id: 'frost-2',
    family: 'Frostbite Arena',
    name: 'Blizzard Rink',
    tier: 2,
    tierName: 'Adapt',
    shape: 'square',
    surface: 'ice',
    theme: FROST_THEME,
    hazards: ['blizzard'],
    blurb: 'Gusting wind shoves everything downwind. Adapt.',
  },
  {
    id: 'frost-3',
    family: 'Frostbite Arena',
    name: 'Icefall Rink',
    tier: 3,
    tierName: 'Master',
    shape: 'square',
    surface: 'ice',
    theme: FROST_THEME,
    hazards: ['blizzard', 'icicles'],
    blurb: 'Icicles crash from above. Master the chaos.',
  },
  {
    id: 'frost-4',
    family: 'Frostbite Arena',
    name: 'Avalanche Rink',
    tier: 4,
    tierName: 'Survive',
    shape: 'square',
    surface: 'ice',
    theme: FROST_THEME,
    hazards: ['blizzard', 'icicles', 'boulders'],
    blurb: 'Wind, ice, and sliding boulders. Just survive.',
  },
];

// Neutral greybox used by the Surface Lab movement test. Not part of the 28.
export const GREYBOX_MAP: MapDef = {
  id: 'greybox',
  family: 'Lab',
  name: 'Surface Lab',
  tier: 1,
  tierName: 'Greybox',
  shape: 'square',
  surface: 'metal',
  theme: {
    skyTop: '#2A2E58',
    skyBot: '#0D1026',
    fog: '#1A1F3D',
    ground: '#151A38',
    trim: 0x2ef2ff,
    light: 0xbfc8ff,
    ambient: 'none',
  },
  hazards: [],
  blurb: 'Quadrant floor: metal · ice · mud · sand, with a conveyor strip. Roam and feel each surface.',
};

export function mapById(id: string): MapDef {
  return [...FROSTBITE_MAPS, GREYBOX_MAP].find((m) => m.id === id) ?? FROSTBITE_MAPS[0];
}
