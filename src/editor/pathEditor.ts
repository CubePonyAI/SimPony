import * as THREE from 'three';
import { clamp } from '../core/math';
import type { ReferenceLine } from '../core/referenceLine';
import { laneCenters } from '../core/scenario';
import type { PathPoint, RoadSpec } from '../core/types';

export interface PathEditorHost {
  dom: HTMLElement;
  camera(): THREE.Camera;
  handles(): THREE.Object3D;
  ref(): ReferenceLine;
  road(): RoadSpec;
  /** Control points of the currently selected agent (mutable, sorted by s). */
  points(): PathPoint[];
  lockCamera(on: boolean): void;
  /** live = true while dragging. */
  changed(live: boolean): void;
  setActive(index: number): void;
  enabled?(): boolean;
}

const SNAP_DIST = 0.6;
const MIN_GAP = 1.0;

/**
 * Edits l(s) control points of the selected agent directly in the 3D view.
 * Drag a handle, double-click road to insert, right-click a handle to delete.
 * Lateral offset snaps to lane centers unless Shift is held.
 */
export class PathEditor {
  private readonly ray = new THREE.Raycaster();
  private readonly ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private dragIndex = -1;

  constructor(private readonly host: PathEditorHost) {
    const d = host.dom;
    // Capture phase so we can pre-empt OrbitControls when a handle is hit.
    d.addEventListener('pointerdown', this.onDown, { capture: true });
    d.addEventListener('pointermove', this.onMove);
    d.addEventListener('pointerup', this.onUp);
    d.addEventListener('dblclick', this.onDblClick);
  }

  private setRay(e: MouseEvent) {
    const r = this.host.dom.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(ndc, this.host.camera());
  }

  private pickHandle(e: MouseEvent): number {
    this.setRay(e);
    const hits = this.ray.intersectObjects(this.host.handles().children, false);
    return hits.length ? (hits[0].object.userData.index as number) : -1;
  }

  private groundFrenet(e: MouseEvent, snap: boolean): { s: number; l: number } | null {
    this.setRay(e);
    const p = new THREE.Vector3();
    if (!this.ray.ray.intersectPlane(this.ground, p)) return null;
    const f = this.host.ref().toFrenet(p.x, -p.z);
    if (snap) {
      for (const c of laneCenters(this.host.road())) {
        if (Math.abs(f.l - c) < SNAP_DIST) f.l = c;
      }
    }
    return f;
  }

  private onDown = (e: PointerEvent) => {
    if (this.host.enabled && !this.host.enabled()) return;
    const i = this.pickHandle(e);
    if (i < 0) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    const pts = this.host.points();
    if (e.button === 2) {
      if (pts.length > 2) {
        pts.splice(i, 1);
        this.host.changed(false);
      }
      return;
    }
    if (e.button !== 0) return;
    this.dragIndex = i;
    this.host.dom.setPointerCapture(e.pointerId);
    this.host.lockCamera(true);
    this.host.setActive(i);
  };

  private onMove = (e: PointerEvent) => {
    if (this.dragIndex < 0) return;
    const f = this.groundFrenet(e, !e.shiftKey);
    if (!f) return;
    const pts = this.host.points();
    const i = this.dragIndex;
    const L = this.host.ref().length;
    const lo = i > 0 ? pts[i - 1].s + MIN_GAP : 0;
    const hi = i < pts.length - 1 ? pts[i + 1].s - MIN_GAP : L;
    const road = this.host.road();
    const lMax = (road.laneWidth * road.laneCount) / 2 + 3;
    pts[i] = { s: clamp(f.s, lo, hi), l: clamp(f.l, -lMax, lMax) };
    this.host.changed(true);
  };

  private onUp = (e: PointerEvent) => {
    if (this.dragIndex < 0) return;
    this.host.dom.releasePointerCapture(e.pointerId);
    this.dragIndex = -1;
    this.host.lockCamera(false);
    this.host.setActive(-1);
    this.host.changed(false);
  };

  private onDblClick = (e: MouseEvent) => {
    if (this.host.enabled && !this.host.enabled()) return;
    const pts = this.host.points();
    if (pts.length < 2) return; // static objects have a single point; move by dragging
    const f = this.groundFrenet(e, !e.shiftKey);
    if (!f) return;
    const road = this.host.road();
    if (Math.abs(f.l) > (road.laneWidth * road.laneCount) / 2 + 3) return;
    if (pts.some((p) => Math.abs(p.s - f.s) < MIN_GAP)) return;
    pts.push(f);
    pts.sort((a, b) => a.s - b.s);
    this.host.changed(false);
  };
}
