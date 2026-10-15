import * as THREE from 'three';
import type { ReferenceLine } from '../core/referenceLine';

/** sim (x, y) -> three (x, h, -y) */
export const toThree = (x: number, y: number, h = 0) => new THREE.Vector3(x, h, -y);

function stripGeometry(left: number[], right: number[]): THREE.BufferGeometry {
  // left/right: flat [x,y,z,...]; "right" is the l0 side, "left" the l1 side.
  const n = right.length / 3;
  const pos = new Float32Array(n * 6);
  const idx: number[] = [];
  for (let i = 0; i < n; i++) {
    pos.set(right.slice(i * 3, i * 3 + 3), i * 6);
    pos.set(left.slice(i * 3, i * 3 + 3), i * 6 + 3);
    if (i < n - 1) {
      const k = i * 2;
      idx.push(k, k + 2, k + 1, k + 1, k + 2, k + 3);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Flat strip on the reference line between lateral offsets l0 < l1. */
export function frenetRibbon(
  ref: ReferenceLine,
  s0: number,
  s1: number,
  l0: number,
  l1: number,
  h: number,
  step = 1,
): THREE.BufferGeometry {
  const n = Math.max(2, Math.ceil((s1 - s0) / step) + 1);
  const r: number[] = [];
  const l: number[] = [];
  for (let i = 0; i < n; i++) {
    const s = s0 + ((s1 - s0) * i) / (n - 1);
    const a = ref.toWorld(s, l0);
    const b = ref.toWorld(s, l1);
    r.push(a.x, h, -a.y);
    l.push(b.x, h, -b.y);
  }
  return stripGeometry(l, r);
}

/** Flat strip of given half width along a polyline with headings. */
export function polylineRibbon(
  xs: ArrayLike<number>,
  ys: ArrayLike<number>,
  yaws: ArrayLike<number>,
  halfWidth: number,
  h: number,
  stride = 1,
): THREE.BufferGeometry {
  const r: number[] = [];
  const l: number[] = [];
  const n = xs.length;
  for (let i = 0; i < n; i += stride) push(i);
  if ((n - 1) % stride !== 0) push(n - 1);
  function push(i: number) {
    const nx = -Math.sin(yaws[i]) * halfWidth;
    const ny = Math.cos(yaws[i]) * halfWidth;
    r.push(xs[i] - nx, h, -(ys[i] - ny));
    l.push(xs[i] + nx, h, -(ys[i] + ny));
  }
  return stripGeometry(l, r);
}
