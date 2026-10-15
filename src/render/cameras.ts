import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { Pose2 } from '../sim/simulate';
import type { VehicleParams } from '../core/types';
import { toThree } from './geometry';

export type CameraMode = 'top' | 'adv' | 'third';

// Keep below the style's fog-near distance so the top view is not hazed.
const TOP_HEIGHT = 80;

/**
 * Three camera modes:
 *  - top:   orthographic bird's-eye (editing view), pan/zoom, optional follow.
 *  - adv:   driver's seat view attached to the ADV.
 *  - third: free orbit around the ADV (rotate/zoom/pan), follows the ADV.
 */
export class CameraRig {
  mode: CameraMode = 'third';
  followTop = false;
  readonly top: THREE.OrthographicCamera;
  readonly adv: THREE.PerspectiveCamera;
  readonly third: THREE.PerspectiveCamera;
  private readonly topCtl: OrbitControls;
  private readonly thirdCtl: OrbitControls;
  private readonly topViewHeight = 90;
  private lastTarget: THREE.Vector3 | null = null;
  private interactionLock = false;
  private lookYaw = 0;
  private lookPitch = 0;

  constructor(dom: HTMLElement, aspect: number) {
    const h = this.topViewHeight / 2;
    this.top = new THREE.OrthographicCamera(-h * aspect, h * aspect, h, -h, 1, 200);
    this.top.up.set(0, 0, -1);
    this.top.position.set(0, TOP_HEIGHT, 0);
    this.topCtl = new OrbitControls(this.top, dom);
    this.topCtl.enableRotate = false;
    this.topCtl.screenSpacePanning = true;
    this.topCtl.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    this.topCtl.minZoom = 0.2;
    this.topCtl.maxZoom = 8;

    this.adv = new THREE.PerspectiveCamera(75, aspect, 0.025, 1000);
    this.adv.rotation.order = 'YXZ';

    this.third = new THREE.PerspectiveCamera(50, aspect, 0.3, 1500);
    this.thirdCtl = new OrbitControls(this.third, dom);
    this.thirdCtl.enableDamping = true;
    this.thirdCtl.maxPolarAngle = Math.PI * 0.495;
    this.thirdCtl.minDistance = 4;
    this.thirdCtl.maxDistance = 300;
    // Drag in cockpit view to inspect mirrors / cabin. Double-click to face forward.
    let drag: { id: number; x: number; y: number } | undefined;
    dom.addEventListener('pointerdown', (e) => {
      if (this.mode !== 'adv' || e.button !== 0) return;
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
      dom.setPointerCapture(e.pointerId);
    });
    dom.addEventListener('pointermove', (e) => {
      if (!drag || this.mode !== 'adv') return;
      this.lookYaw = THREE.MathUtils.clamp(this.lookYaw - (e.clientX - drag.x) * 0.004, -2.4, 2.4);
      this.lookPitch = THREE.MathUtils.clamp(this.lookPitch - (e.clientY - drag.y) * 0.003, -0.65, 0.55);
      drag.x = e.clientX; drag.y = e.clientY;
    });
    const release = () => { drag = undefined; };
    dom.addEventListener('pointerup', release);
    dom.addEventListener('pointercancel', release);
    dom.addEventListener('dblclick', () => {
      if (this.mode === 'adv') this.lookYaw = this.lookPitch = 0;
    });
    this.setMode('third');
  }

  get active(): THREE.Camera {
    return this.mode === 'top' ? this.top : this.mode === 'adv' ? this.adv : this.third;
  }

  setMode(mode: CameraMode) {
    this.mode = mode;
    this.applyEnabled();
  }

  /** Temporarily disable camera controls (e.g. while dragging an editor handle). */
  lock(on: boolean) {
    this.interactionLock = on;
    this.applyEnabled();
  }

  private applyEnabled() {
    this.topCtl.enabled = this.mode === 'top' && !this.interactionLock;
    this.thirdCtl.enabled = this.mode === 'third' && !this.interactionLock;
  }

  /** Place cameras around the ADV initially. */
  reset(p: Pose2) {
    const c = toThree(p.x, p.y);
    this.top.position.set(c.x + 25, TOP_HEIGHT, c.z);
    this.topCtl.target.set(c.x + 25, 0, c.z);
    this.top.zoom = 1;
    this.top.updateProjectionMatrix();
    const back = toThree(p.x - Math.cos(p.yaw) * 14, p.y - Math.sin(p.yaw) * 14, 7);
    this.third.position.copy(back);
    this.thirdCtl.target.copy(c).setY(1);
    this.lastTarget = c.clone().setY(1);
    this.topCtl.update();
    this.thirdCtl.update();
  }

  resize(aspect: number) {
    const h = this.topViewHeight / 2;
    Object.assign(this.top, { left: -h * aspect, right: h * aspect, top: h, bottom: -h });
    this.top.updateProjectionMatrix();
    for (const c of [this.adv, this.third]) {
      c.aspect = aspect;
      c.updateProjectionMatrix();
    }
  }

  /** Per-frame update; `advCenter` is the ADV body center pose. `follow`: carry orbit cameras along with ADV motion. */
  update(advCenter: Pose2, vehicle: VehicleParams, follow = true) {
    const c = toThree(advCenter.x, advCenter.y, 1);
    if (this.lastTarget && follow) {
      const d = c.clone().sub(this.lastTarget);
      if (d.lengthSq() > 0) {
        this.third.position.add(d);
        this.thirdCtl.target.add(d);
        if (this.followTop) {
          this.top.position.add(d.setY(0));
          this.topCtl.target.add(d);
        }
      }
    }
    this.lastTarget = c;

    // Driver seat: slightly behind body center, left side (left-hand drive), eye height.
    const fwd = -0.32 * vehicle.length / 4.8;
    const left = 0.43 * vehicle.width / 1.9;
    const cx = advCenter.x + Math.cos(advCenter.yaw) * fwd - Math.sin(advCenter.yaw) * left;
    const cy = advCenter.y + Math.sin(advCenter.yaw) * fwd + Math.cos(advCenter.yaw) * left;
    this.adv.position.copy(toThree(cx, cy, 1.24 * vehicle.height / 1.5));
    this.adv.rotation.set(-0.12 + this.lookPitch, advCenter.yaw - Math.PI / 2 + this.lookYaw, 0);

    this.topCtl.update();
    this.thirdCtl.update();
  }
}
