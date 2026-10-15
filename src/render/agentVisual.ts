import * as THREE from 'three';
import type { AgentSpec } from '../core/types';
import { toThree } from './geometry';
import type { MaterialLibrary, Role } from './styles';

interface ModelHost {
  lib: MaterialLibrary;
  mk(geo: THREE.BufferGeometry, role: Role, cast?: boolean): THREE.Mesh;
}

/** Lightweight procedural sedan. +X forward, -Z driver side, origin at rear axle.
 * All visual dimensions derive from VehicleParams; simulation geometry is unchanged.
 * Canonical body coordinates are centered on a 4.8 × 1.9 × 1.5 m car.
 */
export class AgentVisual {
  readonly group = new THREE.Group();
  private readonly shell = new THREE.Group();
  private readonly bodyMeshes: THREE.Mesh[] = [];
  private readonly frontPivots: THREE.Group[] = [];
  private readonly wheels: THREE.Group[] = [];
  private steering?: THREE.Group;
  private gauge?: THREE.CanvasTexture;
  private gaugeCanvas?: HTMLCanvasElement;
  private lastGauge = '';
  private spin = 0;
  private previous?: { x: number; y: number };
  private colliding = false;
  private readonly ghost: boolean;

  constructor(
    private readonly host: ModelHost,
    private readonly spec: Pick<AgentSpec, 'kind' | 'vehicle'>,
    private readonly bodyRole: Role,
    ghost = false,
  ) {
    this.ghost = ghost;
    this.group.name = `${ghost ? 'ghost' : spec.kind}-model`;
    const p = spec.vehicle;
    this.group.add(this.shell);
    if (spec.kind === 'cone') {
      this.buildCone();
      return;
    }
    this.shell.position.x = p.length / 2 - p.rearOverhang;
    this.shell.scale.set(p.length / 4.8, p.height / 1.5, p.width / 1.9);
    this.buildExterior();
    if (!ghost) {
      this.buildWheels();
      this.buildInterior(spec.kind === 'adv');
    }
  }

  private mesh(g: THREE.BufferGeometry, role: Role, parent: THREE.Object3D = this.shell) {
    const m = this.host.mk(g, this.ghost ? 'ghost' : role, !this.ghost);
    // Glass should not turn an otherwise open cockpit into a solid shadow box.
    if (role === 'glass') m.castShadow = m.receiveShadow = false;
    if (role === this.bodyRole || (this.spec.kind === 'cone' && role === 'coneBody')) this.bodyMeshes.push(m);
    parent.add(m);
    return m;
  }

  private box(role: Role, size: number[], pos: number[], parent: THREE.Object3D = this.shell) {
    const m = this.mesh(new THREE.BoxGeometry(size[0], size[1], size[2]), role, parent);
    m.position.set(pos[0], pos[1], pos[2]);
    return m;
  }

  private beam(role: Role, a: number[], b: number[], thickness: number) {
    const start = new THREE.Vector3(...a as [number, number, number]);
    const end = new THREE.Vector3(...b as [number, number, number]);
    const m = this.mesh(new THREE.CylinderGeometry(thickness, thickness, start.distanceTo(end), 6), role);
    m.position.copy(start).add(end).multiplyScalar(0.5);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), end.sub(start).normalize());
    return m;
  }

  private pane(points: number[][]) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(points.flat(), 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    g.computeVertexNormals();
    return this.mesh(g, 'glass');
  }

  /** Extruded side profile with softly sloped hood / trunk and faceted bumpers. */
  private buildExterior() {
    const shape = new THREE.Shape();
    const outline = [[-2.4, 0.42], [-2.32, 0.72], [-1.65, 0.86], [-1.62, 0.44],
      [0.94, 0.44], [0.95, 0.86],
      [2.22, 0.73], [2.4, 0.56], [2.33, 0.33], [-2.26, 0.33]];
    outline.forEach(([x, y], i) => i ? shape.lineTo(x, y) : shape.moveTo(x, y));
    shape.closePath();
    // Open passenger compartment: no opaque cabin-sized cuboid.
    const g = new THREE.ExtrudeGeometry(shape, { depth: 1.78, bevelEnabled: true,
      bevelThickness: 0.045, bevelSize: 0.045, bevelSegments: 1, steps: 1 });
    g.translate(0, 0, -0.89);
    this.mesh(g, this.bodyRole);
    this.box('interior', [2.7, 0.1, 1.72], [-0.32, 0.4, 0]);
    this.box(this.bodyRole, [1.9, 0.08, 1.45], [-0.3, 1.46, 0]);

    // Windshield and backlight: thin transparent surfaces, not a solid glass block.
    this.pane([[1.05, 0.88, -0.85], [1.05, 0.88, 0.85], [0.65, 1.42, 0.7], [0.65, 1.42, -0.7]]);
    this.pane([[-1.7, 0.88, 0.85], [-1.7, 0.88, -0.85], [-1.25, 1.42, -0.7], [-1.25, 1.42, 0.7]]);
    for (const side of [-1, 1]) {
      const lower = side * 0.86, upper = side * 0.72;
      this.pane([[1.02, 0.88, lower], [0.65, 1.42, upper], [-0.35, 1.42, upper], [-0.35, 0.88, lower]]);
      this.pane([[-0.4, 0.88, lower], [-0.4, 1.42, upper], [-1.25, 1.42, upper], [-1.67, 0.88, lower]]);
      this.beam(this.bodyRole, [1.08, 0.84, lower], [0.65, 1.45, upper], 0.045);
      this.beam('trim', [-0.38, 0.86, lower], [-0.38, 1.44, upper], 0.036);
      this.beam(this.bodyRole, [-1.72, 0.84, lower], [-1.25, 1.45, upper], 0.06);
      // Lower doors, window sill, door gaps, handles and mirrors.
      this.box(this.bodyRole, [2.62, 0.38, 0.09], [-0.32, 0.65, side * 0.9]);
      this.box('trim', [2.65, 0.035, 0.07], [-0.32, 0.87, side * 0.91]);
      this.box('trim', [0.015, 0.34, 0.012], [-0.38, 0.66, side * 0.952]);
      for (const x of [-1.28, 0.02]) this.box('metal', [0.19, 0.035, 0.022], [x, 0.78, side * 0.96]);
      this.box('trim', [0.16, 0.045, 0.18], [0.76, 0.96, side * 0.98]);
      this.box(this.bodyRole, [0.27, 0.14, 0.16], [0.73, 1.01, side * 1.08]);
      this.box('mirror', [0.012, 0.095, 0.13], [0.588, 1.01, side * 1.08]);
      this.box('trim', [3.35, 0.09, 0.08], [-0.14, 0.36, side * 0.91]);
    }
    if (this.ghost) return;
    this.box('trim', [0.09, 0.16, 1.15], [2.39, 0.48, 0]);
    for (let z = -0.45; z < 0.5; z += 0.15) this.box('metal', [0.01, 0.105, 0.025], [2.44, 0.48, z]);
    for (const side of [-1, 1]) {
      this.box('headlight', [0.09, 0.13, 0.43], [2.32, 0.67, side * 0.64]);
      this.box('taillight', [0.06, 0.13, 0.44], [-2.39, 0.68, side * 0.64]);
      this.box('metal', [0.12, 0.07, 0.16], [-2.39, 0.36, side * 0.55]);
    }
    this.box('reflector', [0.02, 0.1, 0.38], [-2.44, 0.48, 0]);
    this.box('trim', [0.02, 0.04, 0.27], [-2.455, 0.48, 0]);
    this.box('taillight', [0.035, 0.04, 0.38], [-1.56, 1.04, 0]);
    // Wipers at the base of the windshield.
    for (const z of [-0.4, 0.3]) this.beam('trim', [1.06, 0.9, z - 0.25], [0.99, 0.98, z + 0.22], 0.012);
    if (this.spec.kind === 'adv') {
      this.box('trim', [0.65, 0.035, 0.5], [-0.55, 1.525, 0]);
      const lidar = this.mesh(new THREE.CylinderGeometry(0.19, 0.22, 0.18, 16), 'advAccent');
      lidar.position.set(-0.55, 1.63, 0);
      const band = this.mesh(new THREE.CylinderGeometry(0.205, 0.205, 0.045, 16), 'glass');
      band.position.set(-0.55, 1.65, 0);
    }
  }

  private buildWheels() {
    const p = this.spec.vehicle;
    // Wheel positions in actual meters, so rear axle = 0 and front axle = wheelbase.
    for (const x of [0, p.wheelbase]) for (const side of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(x, 0.34, side * (p.width / 2 - 0.1));
      this.group.add(pivot);
      if (x > 0) this.frontPivots.push(pivot);
      const rolling = new THREE.Group();
      pivot.add(rolling);
      this.wheels.push(rolling);
      const tire = this.mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.24, 20).rotateX(Math.PI / 2), 'wheel', rolling);
      tire.receiveShadow = true;
      const rim = this.mesh(new THREE.CylinderGeometry(0.23, 0.23, 0.252, 16).rotateX(Math.PI / 2), 'metal', rolling);
      rim.position.z = side * 0.006;
      for (let i = 0; i < 5; i++) {
        const spoke = this.box('trim', [0.32, 0.047, 0.014], [0, 0, side * 0.14], rolling);
        spoke.rotation.z = i * Math.PI / 5;
      }
      const hub = this.mesh(new THREE.CylinderGeometry(0.065, 0.065, 0.02, 10).rotateX(Math.PI / 2), 'metal', rolling);
      hub.position.z = side * 0.155;
    }
  }

  private buildInterior(detailed: boolean) {
    // Door cards and upholstered front / rear seats.
    for (const side of [-1, 1]) {
      this.box('interior', [2.5, 0.37, 0.07], [-0.3, 0.64, side * 0.82]);
      this.box('seat', [1.1, 0.06, 0.11], [-0.22, 0.7, side * 0.75]);
      this.box('metal', [0.14, 0.025, 0.03], [0.25, 0.77, side * 0.77]);
      const z = side * 0.43;
      for (const x of [-0.48, -1.25]) {
        this.box('seat', [0.55, 0.15, 0.58], [x, 0.56, z]);
        const back = this.box('seat', [0.13, 0.55, 0.58], [x - 0.25, 0.83, z]);
        back.rotation.z = -0.12;
        this.box('seat', [0.13, 0.17, 0.27], [x - 0.28, 1.18, z]);
      }
    }
    // Dash is below the eye line, with a separate upper brow.
    this.box('interior', [0.52, 0.23, 1.66], [0.69, 0.79, 0]);
    this.box('trim', [0.56, 0.055, 1.68], [0.68, 0.935, 0]);
    this.box('interior', [1.2, 0.26, 0.22], [0.05, 0.56, 0]);
    if (!detailed) return;
    // Center console, gear selector, cupholders, pedals and vents.
    this.box('metal', [0.85, 0.025, 0.18], [0.08, 0.7, 0]);
    this.box('trim', [0.11, 0.09, 0.09], [0.18, 0.75, 0]);
    for (const x of [-0.1, -0.3]) {
      const cup = this.mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.008, 12), 'trim');
      cup.position.set(x, 0.72, 0);
    }
    for (const z of [-0.7, -0.15, 0.2, 0.65]) {
      this.box('trim', [0.025, 0.055, 0.15], [0.414, 0.85, z]);
      for (let y = 0.835; y <= 0.87; y += 0.015) this.box('metal', [0.029, 0.005, 0.13], [0.41, y, z]);
    }
    for (const z of [-0.52, -0.32]) this.box('trim', [0.08, 0.025, 0.09], [0.65, 0.47, z]);
    this.box('interior', [0.18, 0.06, 0.43], [0.46, 1.035, -0.43]);

    // Steering wheel normal along local +X, with a slightly tilted column.
    this.steering = new THREE.Group();
    this.steering.position.set(0.13, 0.94, -0.43);
    this.steering.rotation.z = -0.22;
    this.shell.add(this.steering);
    const ring = this.mesh(new THREE.TorusGeometry(0.18, 0.022, 6, 24), 'trim', this.steering);
    ring.rotation.y = Math.PI / 2;
    this.box('interior', [0.055, 0.085, 0.14], [0, 0, 0], this.steering);
    this.box('metal', [0.025, 0.027, 0.32], [0, 0, 0], this.steering);
    this.box('trim', [0.025, 0.15, 0.028], [0, -0.075, 0], this.steering);

    // Interior mirror: intentionally a stylized reflective surface, not a costly second render.
    this.beam('trim', [0.63, 1.39, 0], [0.62, 1.27, 0], 0.016);
    this.box('trim', [0.065, 0.11, 0.27], [0.62, 1.26, 0]);
    this.box('mirror', [0.009, 0.083, 0.24], [0.582, 1.26, 0]);
    this.buildGauge();
  }

  private buildGauge() {
    this.gaugeCanvas = document.createElement('canvas');
    this.gaugeCanvas.width = 512; this.gaugeCanvas.height = 192;
    this.gauge = new THREE.CanvasTexture(this.gaugeCanvas);
    this.gauge.colorSpace = THREE.SRGBColorSpace;
    const material = new THREE.MeshBasicMaterial({ map: this.gauge, toneMapped: false });
    const instrument = new THREE.Mesh(new THREE.PlaneGeometry(0.4, 0.15), material);
    instrument.rotation.y = -Math.PI / 2;
    instrument.position.set(0.36, 0.97, -0.43);
    instrument.userData.ownedMaterial = true;
    instrument.name = 'live-instrument-cluster';
    this.shell.add(instrument);
    // Same canvas drives the center screen, keeping texture count low.
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.27, 0.13), material);
    screen.rotation.y = -Math.PI / 2;
    screen.position.set(0.405, 0.88, 0.12);
    screen.userData.ownedMaterial = true;
    this.shell.add(screen);
  }

  private buildCone() {
    const p = this.spec.vehicle;
    const off = p.length / 2 - p.rearOverhang;
    this.box('wheel', [p.length, 0.065, p.width], [off, 0.033, 0]);
    // Alternating tapered orange and reflective bands, sharing the same silhouette.
    const h = p.height - 0.065;
    const radius = p.width * 0.43;
    for (let i = 0; i < 5; i++) {
      const bottom = radius * (1 - i / 5), top = radius * (1 - (i + 1) / 5);
      const band = this.mesh(new THREE.CylinderGeometry(Math.max(top, 0.01), bottom, h / 5, 12), i % 2 ? 'reflector' : 'coneBody');
      band.position.set(off, 0.065 + h * (i + 0.5) / 5, 0);
    }
  }

  setPose(x: number, y: number, yaw: number, steer = 0, speed = 0, accel = 0) {
    this.group.position.copy(toThree(x, y));
    this.group.rotation.y = yaw;
    if (this.previous) {
      const distance = Math.hypot(x - this.previous.x, y - this.previous.y);
      if (distance < 3) this.spin += distance / 0.34;
    }
    this.previous = { x, y };
    for (const p of this.frontPivots) p.rotation.y = steer;
    for (const w of this.wheels) w.rotation.z = -this.spin;
    if (this.steering) this.steering.rotation.x = -steer * 14;
    this.updateGauge(speed, accel, steer);
  }

  private updateGauge(speed: number, accel: number, steer: number) {
    if (!this.gaugeCanvas || !this.gauge) return;
    const kph = Math.round(speed * 3.6);
    const label = `${kph}/${accel.toFixed(1)}/${steer.toFixed(2)}`;
    if (label === this.lastGauge) return;
    this.lastGauge = label;
    const g = this.gaugeCanvas.getContext('2d')!;
    g.fillStyle = '#101d27'; g.fillRect(0, 0, 512, 192);
    g.strokeStyle = '#62d6cf'; g.lineWidth = 4;
    g.beginPath(); g.arc(160, 138, 104, Math.PI, Math.PI * 2); g.stroke();
    g.fillStyle = '#f3f4e9'; g.textAlign = 'center';
    g.font = 'bold 80px system-ui'; g.fillText(String(kph), 160, 128);
    g.font = '20px system-ui'; g.fillText('km/h', 160, 163);
    g.fillStyle = '#62d6cf'; g.font = 'bold 24px system-ui'; g.fillText('D  ·  ADV', 385, 55);
    g.fillStyle = '#cbd8e4'; g.font = '20px monospace';
    g.fillText(`${accel.toFixed(1)} m/s²`, 385, 101);
    g.fillText(`${(steer * 180 / Math.PI).toFixed(1)}° steer`, 385, 140);
    this.gauge.needsUpdate = true;
  }

  setColliding(on: boolean) {
    if (on === this.colliding || this.ghost) return;
    this.colliding = on;
    for (const m of this.bodyMeshes) {
      m.userData.role = on ? 'collision' : this.bodyRole;
      m.material = this.host.lib.get(m.userData.role);
    }
  }
}