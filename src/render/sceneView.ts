import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { ReferenceLine } from '../core/referenceLine';
import type { CompiledScenario } from '../core/scenario';
import type { AgentSpec, RoadSpec, VehicleParams } from '../core/types';
import type { SimFrame, SimResult } from '../sim/simulate';
import { frenetRibbon, polylineRibbon, toThree } from './geometry';
import { MaterialLibrary, type Role, type StylePreset } from './styles';

function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function disposeGroup(g: THREE.Object3D) {
  g.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).geometry.dispose();
  });
  g.clear();
}

/** Visual for a car / cone; group origin = rear axle reference point. */
class AgentVisual {
  readonly group = new THREE.Group();
  private readonly bodyMeshes: THREE.Mesh[] = [];
  private readonly frontPivots: THREE.Object3D[] = [];
  private colliding = false;

  constructor(
    private readonly view: SceneView,
    spec: Pick<AgentSpec, 'kind' | 'vehicle'>,
    private readonly bodyRole: Role,
    ghost = false,
  ) {
    const vp = spec.vehicle;
    const role = (r: Role): Role => (ghost ? 'ghost' : r);
    const cast = !ghost;
    if (spec.kind === 'cone') {
      const off = vp.length / 2 - vp.rearOverhang;
      const cone = view.mk(new THREE.ConeGeometry(vp.width * 0.45, vp.height, 10), role('coneBody'), cast);
      cone.position.set(off, vp.height / 2, 0);
      const base = view.mk(new THREE.BoxGeometry(vp.width, 0.06, vp.width), role('coneBody'), cast);
      base.position.set(off, 0.03, 0);
      this.group.add(cone, base);
      this.bodyMeshes.push(cone, base);
      return;
    }
    this.buildCar(vp, role, cast, spec.kind === 'adv');
  }

  private buildCar(vp: VehicleParams, role: (r: Role) => Role, cast: boolean, isAdv: boolean) {
    const wr = 0.36;
    const off = vp.length / 2 - vp.rearOverhang;
    const bodyH = vp.height * 0.45;
    const bodyY = 0.28 + bodyH / 2;
    const body = this.view.mk(new THREE.BoxGeometry(vp.length, bodyH, vp.width), role(this.bodyRole), cast);
    body.position.set(off, bodyY, 0);
    const cabinH = vp.height - 0.28 - bodyH;
    const cabin = this.view.mk(new THREE.BoxGeometry(vp.length * 0.5, cabinH * 0.85, vp.width * 0.88), role('glass'), cast);
    cabin.position.set(off - vp.length * 0.06, 0.28 + bodyH + (cabinH * 0.85) / 2, 0);
    const roof = this.view.mk(new THREE.BoxGeometry(vp.length * 0.46, cabinH * 0.15, vp.width * 0.84), role(this.bodyRole), cast);
    roof.position.set(off - vp.length * 0.06, 0.28 + bodyH + cabinH * 0.85 + (cabinH * 0.15) / 2, 0);
    this.group.add(body, cabin, roof);
    this.bodyMeshes.push(body, roof);

    const wheelGeo = new THREE.CylinderGeometry(wr, wr, 0.28, 14).rotateX(Math.PI / 2);
    const zw = vp.width / 2 - 0.16;
    for (const x of [0, vp.wheelbase]) {
      for (const z of [zw, -zw]) {
        const w = this.view.mk(wheelGeo, role('wheel'), cast);
        if (x > 0) {
          const pivot = new THREE.Group();
          pivot.position.set(x, wr, z);
          pivot.add(w);
          this.frontPivots.push(pivot);
          this.group.add(pivot);
        } else {
          w.position.set(x, wr, z);
          this.group.add(w);
        }
      }
    }
    if (isAdv) {
      const lidar = this.view.mk(new THREE.CylinderGeometry(0.25, 0.28, 0.3, 16), role('advAccent'), cast);
      lidar.position.set(off - vp.length * 0.06, vp.height + 0.15, 0);
      this.group.add(lidar);
    }
  }

  setPose(x: number, y: number, yaw: number, steer = 0) {
    this.group.position.copy(toThree(x, y));
    this.group.rotation.y = yaw;
    for (const p of this.frontPivots) p.rotation.y = steer;
  }

  setColliding(on: boolean) {
    if (on === this.colliding) return;
    this.colliding = on;
    for (const m of this.bodyMeshes) {
      m.userData.role = on ? 'collision' : this.bodyRole;
      m.material = this.view.lib.get(m.userData.role);
    }
  }
}

export interface OverlayOptions {
  showGhost: boolean;
  showTrace: boolean;
  showObsPaths: boolean;
}

export class SceneView {
  readonly scene = new THREE.Scene();
  readonly lib: MaterialLibrary;
  readonly handleGroup = new THREE.Group();
  private readonly sun = new THREE.DirectionalLight();
  private readonly hemi = new THREE.HemisphereLight();
  private readonly staticGroup = new THREE.Group();
  private readonly agentGroup = new THREE.Group();
  private readonly overlayGroup = new THREE.Group();
  private readonly selectionRing: THREE.Mesh;
  private adv?: AgentVisual;
  private ghost?: AgentVisual;
  private obstacles: AgentVisual[] = [];

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    style: StylePreset,
  ) {
    this.lib = new MaterialLibrary(style);
    this.sun.position.set(-80, 120, 60);
    this.sun.target.position.set(0, 0, -12);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(4096, 4096);
    Object.assign(this.sun.shadow.camera, { left: -180, right: 180, top: 180, bottom: -180, near: 1, far: 400 });
    this.sun.shadow.bias = -0.0005;
    this.scene.add(this.sun, this.sun.target, this.hemi);
    this.scene.add(this.staticGroup, this.agentGroup, this.overlayGroup, this.handleGroup);
    this.selectionRing = this.mk(new THREE.RingGeometry(3.0, 3.2, 48).rotateX(-Math.PI / 2), 'selection', false);
    this.selectionRing.visible = false;
    this.overlayGroup.add(this.selectionRing);
    this.applyStyle(style);
  }

  mk(geo: THREE.BufferGeometry, role: Role, cast = true): THREE.Mesh {
    const m = new THREE.Mesh(geo, this.lib.get(role));
    m.userData.role = role;
    m.castShadow = cast;
    m.receiveShadow = role !== 'ghost';
    return m;
  }

  applyStyle(style: StylePreset) {
    this.lib.setStyle(style);
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && m.userData.role) m.material = this.lib.get(m.userData.role);
    });
    this.scene.background = new THREE.Color(style.background);
    this.scene.fog = new THREE.Fog(style.background, style.fog[0], style.fog[1]);
    this.sun.color.set(style.sun.color);
    this.sun.intensity = style.sun.intensity;
    this.hemi.color.set(style.hemi.sky);
    this.hemi.groundColor.set(style.hemi.ground);
    this.hemi.intensity = style.hemi.intensity;
    this.renderer.toneMapping = style.toneMapping;
    this.renderer.toneMappingExposure = style.exposure;
  }

  // ---------------- Static world ----------------

  buildWorld(ref: ReferenceLine, road: RoadSpec) {
    disposeGroup(this.staticGroup);
    const g = this.staticGroup;
    const L = ref.length;
    const half = (road.laneWidth * road.laneCount) / 2;

    const ground = this.mk(new THREE.PlaneGeometry(1200, 1200).rotateX(-Math.PI / 2), 'ground', false);
    g.add(ground);
    g.add(this.mk(frenetRibbon(ref, 0, L, -half, half, 0.02), 'road', false));
    g.add(this.mk(frenetRibbon(ref, 0, L, half, half + 3, 0.03), 'shoulder', false));
    g.add(this.mk(frenetRibbon(ref, 0, L, -half - 3, -half, 0.03), 'shoulder', false));

    const lw = 0.15;
    const parts: THREE.BufferGeometry[] = [
      frenetRibbon(ref, 0, L, half - 0.3 - lw, half - 0.3, 0.04),
      frenetRibbon(ref, 0, L, -half + 0.3, -half + 0.3 + lw, 0.04),
    ];
    for (let i = 1; i < road.laneCount; i++) {
      const c = -half + i * road.laneWidth;
      for (let s = 2; s < L - 4; s += 10) parts.push(frenetRibbon(ref, s, s + 4, c - lw / 2, c + lw / 2, 0.04));
    }
    g.add(this.mk(mergeGeometries(parts), 'lane', false));
    parts.forEach((p) => p.dispose());

    this.buildEnvironment(ref, half);
  }

  private buildEnvironment(ref: ReferenceLine, half: number) {
    const rand = rng(7);
    const L = ref.length;
    const clear = half + 5;
    const ok = (x: number, y: number, r: number) => Math.abs(ref.toFrenet(x, y).l) > clear + r;

    const leafA = new THREE.IcosahedronGeometry(1.7, 0);
    const leafB = new THREE.IcosahedronGeometry(1.1, 0);
    const trunk = new THREE.CylinderGeometry(0.22, 0.3, 1.8, 6);
    for (let s = 4; s < L; s += 7 + rand() * 6) {
      for (const side of [1, -1]) {
        if (rand() < 0.25) continue;
        const p = ref.toWorld(s, side * (clear + 6 + rand() * 14));
        if (!ok(p.x, p.y, 2)) continue;
        const k = 0.8 + rand() * 0.5;
        const tree = new THREE.Group();
        const tr = this.mk(trunk, 'trunk');
        tr.position.y = 0.9;
        const a = this.mk(leafA, 'leaf');
        a.position.y = 2.7;
        a.scale.setScalar(k);
        const b = this.mk(leafB, 'leaf');
        b.position.set(0.3, 3.9 * k, 0.2);
        b.scale.setScalar(k);
        tree.add(tr, a, b);
        tree.position.copy(toThree(p.x, p.y));
        tree.rotation.y = rand() * Math.PI;
        this.staticGroup.add(tree);
      }
    }
    for (let s = 10; s < L; s += 18 + rand() * 10) {
      for (const side of [1, -1]) {
        if (rand() < 0.3) continue;
        const w = 8 + rand() * 8;
        const d = 8 + rand() * 6;
        const h = 6 + rand() * 20;
        const p = ref.toWorld(s, side * (clear + 30 + rand() * 20));
        if (!ok(p.x, p.y, Math.max(w, d))) continue;
        const yaw = ref.pose(s).yaw;
        const b = this.mk(new THREE.BoxGeometry(w, h, d), 'building');
        b.position.copy(toThree(p.x, p.y, h / 2));
        b.rotation.y = yaw;
        const r = this.mk(new THREE.BoxGeometry(w + 0.6, 0.6, d + 0.6), 'roof');
        r.position.copy(toThree(p.x, p.y, h + 0.3));
        r.rotation.y = yaw;
        this.staticGroup.add(b, r);
      }
    }
  }

  // ---------------- Agents ----------------

  setAgents(adv: AgentSpec, obstacles: AgentSpec[]) {
    disposeGroup(this.agentGroup);
    this.adv = new AgentVisual(this, adv, 'advBody');
    this.ghost = new AgentVisual(this, adv, 'advBody', true);
    this.obstacles = obstacles.map((o) => new AgentVisual(this, o, o.kind === 'cone' ? 'coneBody' : 'obsBody'));
    this.agentGroup.add(this.adv.group, this.ghost.group, ...this.obstacles.map((o) => o.group));
  }

  updateFrame(f: SimFrame, opts: OverlayOptions, selectedObstacle: number) {
    if (!this.adv || !this.ghost) return;
    this.adv.setPose(f.adv.x, f.adv.y, f.adv.yaw, f.adv.steer);
    this.adv.setColliding(f.collisions.length > 0);
    const ghostOn = opts.showGhost && (Math.abs(f.adv.latErr) > 0.01 || Math.abs(f.adv.lonErr) > 0.01);
    this.ghost.group.visible = ghostOn;
    if (ghostOn) this.ghost.setPose(f.adv.ref.x, f.adv.ref.y, f.adv.ref.yaw);
    this.obstacles.forEach((o, i) => {
      const p = f.obs[i];
      if (!p) return;
      o.setPose(p.x, p.y, p.yaw);
      o.setColliding(f.collisions.includes(i));
    });
    const sel = selectedObstacle >= 0 ? f.obs[selectedObstacle] : { x: f.adv.x, y: f.adv.y, yaw: f.adv.yaw };
    this.selectionRing.visible = !!sel;
    if (sel) this.selectionRing.position.copy(toThree(sel.x, sel.y, 0.08));
  }

  // ---------------- Overlays ----------------

  setOverlays(c: CompiledScenario, sim: SimResult | null, selectedObstacle: number, opts: OverlayOptions) {
    for (const o of [...this.overlayGroup.children]) {
      if (o === this.selectionRing) continue;
      (o as THREE.Mesh).geometry.dispose();
      this.overlayGroup.remove(o);
    }
    const p = c.adv.path;
    if (p.count > 1) this.overlayGroup.add(this.mk(polylineRibbon(p.x, p.y, p.yaw, 0.25, 0.06, 2), 'advPath', false));

    c.obstacles.forEach((o, i) => {
      const sel = i === selectedObstacle;
      if (o.path.count < 2 || (!opts.showObsPaths && !sel)) return;
      const role: Role = sel ? 'selection' : 'obsPath';
      this.overlayGroup.add(this.mk(polylineRibbon(o.path.x, o.path.y, o.path.yaw, sel ? 0.2 : 0.15, 0.055, 4), role, false));
    });

    if (sim && opts.showTrace && sim.frames.length > 1 && sim.maxLatErr > 0) {
      const xs = sim.frames.map((f) => f.adv.x);
      const ys = sim.frames.map((f) => f.adv.y);
      const yaws = sim.frames.map((f) => f.adv.yaw);
      this.overlayGroup.add(this.mk(polylineRibbon(xs, ys, yaws, 0.06, 0.075, 2), 'trace', false));
    }
  }

  /** Path control handles for the selected agent (world positions). */
  setHandles(points: { x: number; y: number }[], active: number) {
    disposeGroup(this.handleGroup);
    const geo = new THREE.CylinderGeometry(0.7, 0.7, 0.25, 20);
    points.forEach((pt, i) => {
      const m = this.mk(geo, i === active ? 'handleActive' : 'handle', false);
      m.position.copy(toThree(pt.x, pt.y, 0.15));
      m.userData.index = i;
      this.handleGroup.add(m);
    });
  }
}
