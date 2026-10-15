import * as THREE from 'three';

/**
 * Rendering style is orthogonal to simulation logic: every mesh only carries a
 * semantic `role`; a StylePreset maps roles to materials, lights and atmosphere.
 * Adding a new style = adding a new preset, no scene/sim code changes.
 */
export type Role =
  | 'ground'
  | 'road'
  | 'shoulder'
  | 'lane'
  | 'advBody'
  | 'advAccent'
  | 'obsBody'
  | 'coneBody'
  | 'glass'
  | 'wheel'
  | 'metal'
  | 'trim'
  | 'interior'
  | 'seat'
  | 'headlight'
  | 'taillight'
  | 'reflector'
  | 'mirror'
  | 'leaf'
  | 'trunk'
  | 'building'
  | 'roof'
  | 'advPath'
  | 'obsPath'
  | 'trace'
  | 'ghost'
  | 'handle'
  | 'handleActive'
  | 'collision'
  | 'selection';

export interface StylePreset {
  name: string;
  background: number;
  fog: [near: number, far: number];
  sun: { color: number; intensity: number };
  hemi: { sky: number; ground: number; intensity: number };
  toneMapping: THREE.ToneMapping;
  exposure: number;
  palette: Record<Role, number>;
  material(role: Role, color: number): THREE.Material;
}

const OVERLAY_ROLES = new Set<Role>(['lane', 'advPath', 'obsPath', 'trace', 'handle', 'handleActive', 'selection']);

export const LOW_POLY: StylePreset = {
  name: '低多边形清新 Low-poly',
  background: 0xcfe8f3,
  fog: [120, 420],
  sun: { color: 0xffffff, intensity: 2.8 },
  hemi: { sky: 0xeaf6ff, ground: 0xb5c9a8, intensity: 1.4 },
  toneMapping: THREE.NeutralToneMapping,
  exposure: 1.05,
  palette: {
    ground: 0xa8d5a2,
    road: 0x7d8597,
    shoulder: 0xe8dcc4,
    lane: 0xfdfdfd,
    advBody: 0xff8c69,
    advAccent: 0x4a4a55,
    obsBody: 0x7fb7e6,
    coneBody: 0xfb8500,
    glass: 0xd6eef8,
    wheel: 0x4a4a55,
    metal: 0xbac6d1,
    trim: 0x242e38,
    interior: 0x344451,
    seat: 0x887969,
    headlight: 0xfff4ce,
    taillight: 0xf04450,
    reflector: 0xfff7e7,
    mirror: 0xaccbd8,
    leaf: 0x6cc08b,
    trunk: 0xb08968,
    building: 0xf7e1d7,
    roof: 0xe5989b,
    advPath: 0xffb703,
    obsPath: 0x5e9fd6,
    trace: 0xe63946,
    ghost: 0xffffff,
    handle: 0x264653,
    handleActive: 0xe76f51,
    collision: 0xe63946,
    selection: 0x2a9d8f,
  },
  material(role, color) {
    if (role === 'glass') {
      return new THREE.MeshPhysicalMaterial({ color, transparent: true, opacity: 0.16,
        roughness: 0.12, metalness: 0.05, side: THREE.DoubleSide, depthWrite: false });
    }
    if (role === 'headlight' || role === 'taillight') {
      return new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.5, roughness: 0.3 });
    }
    if (role === 'metal' || role === 'mirror') {
      return new THREE.MeshStandardMaterial({ color, metalness: 0.55, roughness: 0.25 });
    }
    if (role === 'ghost') {
      return new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.35, depthWrite: false });
    }
    if (role === 'obsPath') {
      return new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.6, depthWrite: false });
    }
    if (OVERLAY_ROLES.has(role)) return new THREE.MeshBasicMaterial({ color });
    return new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: 1, metalness: 0 });
  },
};

export const STYLES: StylePreset[] = [LOW_POLY];

export class MaterialLibrary {
  private cache = new Map<Role, THREE.Material>();
  style: StylePreset;

  constructor(style: StylePreset) {
    this.style = style;
  }

  get(role: Role): THREE.Material {
    let m = this.cache.get(role);
    if (!m) {
      m = this.style.material(role, this.style.palette[role]);
      this.cache.set(role, m);
    }
    return m;
  }

  setStyle(style: StylePreset): void {
    this.cache.forEach((m) => m.dispose());
    this.cache.clear();
    this.style = style;
  }
}
