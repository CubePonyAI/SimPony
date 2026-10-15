import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// ============================================================
// Renderer / camera / lights
// ============================================================
const renderer = new THREE.WebGLRenderer({ antialias: false });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.5, 800);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI * 0.49;

const hemi = new THREE.HemisphereLight(0xffffff, 0x556655, 1.2);
const sun = new THREE.DirectionalLight(0xffffff, 2.6);
sun.position.set(-60, 90, 40);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -130, right: 130, top: 130, bottom: -130, near: 1, far: 320 });
sun.shadow.bias = -0.0005;
scene.add(hemi, sun);

// ============================================================
// Road reference line + Frenet helpers (3 lanes, 3.5 m each)
// ============================================================
const LANE_W = 3.5;
const ref = new THREE.CatmullRomCurve3(
  [
    new THREE.Vector3(-160, 0, 0),
    new THREE.Vector3(-80, 0, 0),
    new THREE.Vector3(-20, 0, -6),
    new THREE.Vector3(40, 0, -22),
    new THREE.Vector3(100, 0, -24),
    new THREE.Vector3(160, 0, -10),
  ],
  false,
  'centripetal',
);
const L = ref.getLength();
const UP = new THREE.Vector3(0, 1, 0);

// (s, l) -> world. l > 0 is the left side of travel direction.
function frenet(s, l, y = 0) {
  const u = THREE.MathUtils.clamp(s / L, 0, 1);
  const p = ref.getPointAt(u);
  const t = ref.getTangentAt(u);
  const n = new THREE.Vector3().crossVectors(UP, t).normalize();
  return p.addScaledVector(n, l).setY(y);
}

const asFn = (v) => (typeof v === 'function' ? v : () => v);

// Flat strip between lateral offsets l0(s) < l1(s), facing up.
function ribbon(s0, s1, l0, l1, y, step = 1) {
  const f0 = asFn(l0), f1 = asFn(l1);
  const pos = [], idx = [];
  const n = Math.max(2, Math.ceil((s1 - s0) / step) + 1);
  for (let i = 0; i < n; i++) {
    const s = s0 + ((s1 - s0) * i) / (n - 1);
    const a = frenet(s, f0(s), y), b = frenet(s, f1(s), y);
    pos.push(a.x, a.y, a.z, b.x, b.y, b.z);
    if (i < n - 1) {
      const k = i * 2;
      idx.push(k, k + 2, k + 1, k + 1, k + 2, k + 3);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// ============================================================
// Scene building (each mesh carries a "role" used by styles)
// ============================================================
function mk(geo, role, { cast = true } = {}) {
  const m = new THREE.Mesh(geo);
  m.userData.role = role;
  m.castShadow = cast;
  m.receiveShadow = true;
  return m;
}

function rng(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(7);

const ground = mk(new THREE.PlaneGeometry(900, 900), 'ground', { cast: false });
ground.rotation.x = -Math.PI / 2;
scene.add(ground);

const ROAD_HALF = LANE_W * 1.5;
scene.add(mk(ribbon(0, L, -ROAD_HALF, ROAD_HALF, 0.02), 'road', { cast: false }));
scene.add(mk(ribbon(0, L, ROAD_HALF, ROAD_HALF + 3, 0.03), 'shoulder', { cast: false }));
scene.add(mk(ribbon(0, L, -ROAD_HALF - 3, -ROAD_HALF, 0.03), 'shoulder', { cast: false }));

{
  const lw = 0.15, parts = [];
  parts.push(ribbon(0, L, ROAD_HALF - 0.3 - lw, ROAD_HALF - 0.3, 0.04));
  parts.push(ribbon(0, L, -ROAD_HALF + 0.3, -ROAD_HALF + 0.3 + lw, 0.04));
  for (const c of [-LANE_W / 2, LANE_W / 2]) {
    for (let s = 2; s < L - 4; s += 10) parts.push(ribbon(s, s + 4, c - lw / 2, c + lw / 2, 0.04));
  }
  scene.add(mk(mergeGeometries(parts), 'lane', { cast: false }));
}

// Trees + buildings
const leafGeo = new THREE.IcosahedronGeometry(1.7, 1);
const leafGeo2 = new THREE.IcosahedronGeometry(1.1, 1);
const trunkGeo = new THREE.CylinderGeometry(0.22, 0.3, 1.8, 6);
function tree(pos, k) {
  const g = new THREE.Group();
  const trunk = mk(trunkGeo, 'trunk'); trunk.position.y = 0.9;
  const a = mk(leafGeo, 'leaf'); a.position.y = 2.7; a.scale.setScalar(k);
  const b = mk(leafGeo2, 'leaf'); b.position.set(0.3, 3.9 * k, 0.2); b.scale.setScalar(k);
  g.add(trunk, a, b);
  g.position.copy(pos);
  g.rotation.y = rand() * Math.PI;
  scene.add(g);
}
for (let s = 4; s < L; s += 7 + rand() * 6) {
  for (const side of [1, -1]) {
    if (rand() < 0.25) continue;
    tree(frenet(s, side * (12 + rand() * 14)), 0.8 + rand() * 0.5);
  }
}
for (let s = 10; s < L; s += 18 + rand() * 10) {
  for (const side of [1, -1]) {
    if (rand() < 0.3) continue;
    const w = 8 + rand() * 8, d = 8 + rand() * 6, h = 6 + rand() * 20;
    const p = frenet(s, side * (36 + rand() * 20));
    const q = frenet(s + 1, side * 40);
    const yaw = Math.atan2(-(q.z - p.z), q.x - p.x);
    const b = mk(new THREE.BoxGeometry(w, h, d), 'building'); b.position.set(p.x, h / 2, p.z); b.rotation.y = yaw;
    const r = mk(new THREE.BoxGeometry(w + 0.6, 0.6, d + 0.6), 'roof'); r.position.set(p.x, h + 0.3, p.z); r.rotation.y = yaw;
    scene.add(b, r);
  }
}

// Vehicles (local forward = +x)
const wheelGeo = new THREE.CylinderGeometry(0.38, 0.38, 0.3, 14).rotateX(Math.PI / 2);
function makeCar(bodyRole, isAdv = false) {
  const g = new THREE.Group();
  const body = mk(new THREE.BoxGeometry(4.6, 0.9, 1.9), bodyRole); body.position.y = 0.8;
  const cabin = mk(new THREE.BoxGeometry(2.4, 0.7, 1.7), 'glass'); cabin.position.set(-0.3, 1.6, 0);
  const roof = mk(new THREE.BoxGeometry(2.2, 0.12, 1.6), bodyRole); roof.position.set(-0.3, 2.0, 0);
  g.add(body, cabin, roof);
  for (const [x, z] of [[1.5, 0.9], [1.5, -0.9], [-1.5, 0.9], [-1.5, -0.9]]) {
    const w = mk(wheelGeo, 'wheel'); w.position.set(x, 0.38, z); g.add(w);
  }
  if (isAdv) {
    const lidar = mk(new THREE.CylinderGeometry(0.28, 0.32, 0.35, 16), 'advAccent');
    lidar.position.set(-0.3, 2.25, 0);
    g.add(lidar);
  }
  scene.add(g);
  return g;
}

const S_START = 20, S_END = L - 20, ADV_V = 10;
const smooth5 = (x) => { x = THREE.MathUtils.clamp(x, 0, 1); return x * x * x * (10 + x * (-15 + 6 * x)); };
const advL = (s) => LANE_W * smooth5((s - 70) / 40); // lane change: center -> left between s=70..110

const adv = makeCar('advBody', true);
const obs = [
  { car: makeCar('obsBody'), s0: 110, v: 5, l: 0 },
  { car: makeCar('obsBody'), s0: 60, v: 8, l: -LANE_W },
];
const coneGeo = new THREE.ConeGeometry(0.3, 0.8, 10);
for (let i = 0; i < 6; i++) {
  const p = frenet(L - 40 + i * 2.5, (i % 2 ? 0.6 : -0.6));
  const c = mk(coneGeo, 'cone'); c.position.set(p.x, 0.4, p.z); scene.add(c);
}

// Planned ADV path (drawn on the road)
scene.add(mk(ribbon(S_START, S_END, (s) => advL(s) - 0.25, (s) => advL(s) + 0.25, 0.06, 0.5), 'path', { cast: false }));

function place(obj, s, lfn) {
  const l = asFn(lfn);
  const p = frenet(s, l(s));
  const q = frenet(s + 0.5, l(s + 0.5));
  obj.position.set(p.x, 0, p.z);
  obj.rotation.y = Math.atan2(-(q.z - p.z), q.x - p.x);
}

// ============================================================
// Post-processing: normal/depth prepass + stylize pass + bloom
// ============================================================
const pr = renderer.getPixelRatio();
function makeNormalRT(w, h) {
  const rt = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType });
  rt.depthTexture = new THREE.DepthTexture(w, h);
  rt.depthTexture.type = THREE.FloatType;
  return rt;
}
let normalRT = makeNormalRT(innerWidth * pr, innerHeight * pr);
const normalMat = new THREE.MeshNormalMaterial();

const StyleShader = {
  uniforms: {
    tDiffuse: { value: null },
    tNormal: { value: null },
    tDepth: { value: null },
    resolution: { value: new THREE.Vector2(innerWidth * pr, innerHeight * pr) },
    pixelRatio: { value: pr },
    cameraNear: { value: camera.near },
    cameraFar: { value: camera.far },
    edgeStrength: { value: 1 },
    edgeWidth: { value: 1 },
    edgeColor: { value: new THREE.Color() },
    kuwahara: { value: 0 },
    ink: { value: 0 },
    paperColor: { value: new THREE.Color() },
    accentColor: { value: new THREE.Color() },
    saturation: { value: 1 },
    vignette: { value: 0 },
    grain: { value: 0 },
    time: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    #include <packing>
    uniform sampler2D tDiffuse;
    uniform sampler2D tNormal;
    uniform sampler2D tDepth;
    uniform vec2 resolution;
    uniform float pixelRatio, cameraNear, cameraFar, edgeStrength, edgeWidth;
    uniform float kuwahara, ink, saturation, vignette, grain, time;
    uniform vec3 edgeColor, paperColor, accentColor;
    varying vec2 vUv;
    #define KR 4

    float linD(vec2 uv) { return -perspectiveDepthToViewZ(texture2D(tDepth, uv).x, cameraNear, cameraFar); }
    vec3 nrm(vec2 uv) { return texture2D(tNormal, uv).xyz * 2.0 - 1.0; }
    float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    vec3 toSRGB(vec3 c) { return pow(max(c, 0.0), vec3(1.0 / 2.2)); }
    vec3 toLin(vec3 c) { return pow(max(c, 0.0), vec3(2.2)); }
    float hatch(float v, float sp) { float f = abs(mod(v, sp) - sp * 0.5); return smoothstep(0.5, 1.4, f); }

    vec4 kq(vec2 uv, vec2 sgn, vec2 texel) {
      vec3 m = vec3(0.0), s = vec3(0.0);
      for (int j = 0; j <= KR; j++) for (int i = 0; i <= KR; i++) {
        vec3 c = texture2D(tDiffuse, uv + vec2(float(i), float(j)) * sgn * texel).rgb;
        m += c; s += c * c;
      }
      float n = float((KR + 1) * (KR + 1));
      m /= n; s = abs(s / n - m * m);
      return vec4(m, s.r + s.g + s.b);
    }

    void main() {
      vec2 texel = 1.0 / resolution;
      vec3 col = texture2D(tDiffuse, vUv).rgb;

      if (kuwahara > 0.5) {
        vec2 kt = texel * pixelRatio;
        vec4 a = kq(vUv, vec2(-1.0, -1.0), kt), b = kq(vUv, vec2(1.0, -1.0), kt);
        vec4 c = kq(vUv, vec2(-1.0, 1.0), kt), d = kq(vUv, vec2(1.0, 1.0), kt);
        vec4 m = a; if (b.w < m.w) m = b; if (c.w < m.w) m = c; if (d.w < m.w) m = d;
        col = m.rgb;
      }
      float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(vec3(lum), col, saturation);

      // Edges from depth (laplacian) + normals
      vec2 px = texel * edgeWidth * pixelRatio;
      float d = linD(vUv);
      float dl = linD(vUv - vec2(px.x, 0.0)), dr = linD(vUv + vec2(px.x, 0.0));
      float dd = linD(vUv - vec2(0.0, px.y)), du = linD(vUv + vec2(0.0, px.y));
      float de = smoothstep(0.03, 0.08, (abs(dl + dr - 2.0 * d) + abs(du + dd - 2.0 * d)) / d);
      vec3 n = nrm(vUv);
      float ne = length(n - nrm(vUv - vec2(px.x, 0.0))) + length(n - nrm(vUv + vec2(px.x, 0.0)))
               + length(n - nrm(vUv - vec2(0.0, px.y))) + length(n - nrm(vUv + vec2(0.0, px.y)));
      ne = smoothstep(0.8, 1.2, ne);
      float edge = max(de, ne) * (1.0 - smoothstep(cameraFar * 0.3, cameraFar * 0.5, d));

      if (ink > 0.5) {
        vec3 s = toSRGB(col);
        float l = dot(s, vec3(0.299, 0.587, 0.114));
        vec2 p = gl_FragCoord.xy / pixelRatio;
        float h = 1.0;
        if (l < 0.82) h = min(h, hatch(p.x + p.y, 6.0));
        if (l < 0.6)  h = min(h, hatch(p.x - p.y, 6.0));
        if (l < 0.4)  h = min(h, hatch(p.x, 4.0));
        if (l < 0.22) h = min(h, hatch(p.y, 4.0));
        float paperN = 0.94 + 0.06 * hash(floor(p / 2.0));
        vec3 r = mix(vec3(0.13, 0.12, 0.11), toSRGB(paperColor) * paperN, h);
        float sat = max(s.r, max(s.g, s.b)) - min(s.r, min(s.g, s.b));
        r = mix(r, toSRGB(accentColor) * (0.7 + 0.3 * h), smoothstep(0.3, 0.45, sat));
        col = toLin(r);
      }

      col = mix(col, edgeColor, edge * edgeStrength);
      col *= 1.0 - vignette * smoothstep(0.3, 0.8, length(vUv - 0.5));
      col += (hash(vUv * resolution + fract(time) * 100.0) - 0.5) * grain;
      gl_FragColor = vec4(col, 1.0);
    }
  `,
};

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const stylePass = new ShaderPass(StyleShader);
stylePass.uniforms.tNormal.value = normalRT.texture;
stylePass.uniforms.tDepth.value = normalRT.depthTexture;
composer.addPass(stylePass);
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.5, 0.4, 0.9);
composer.addPass(bloom);
composer.addPass(new OutputPass());

const bufSize = new THREE.Vector2();
function renderNormals() {
  renderer.getDrawingBufferSize(bufSize);
  if (bufSize.x !== normalRT.width || bufSize.y !== normalRT.height) {
    normalRT.dispose();
    normalRT = makeNormalRT(bufSize.x, bufSize.y);
    stylePass.uniforms.tNormal.value = normalRT.texture;
    stylePass.uniforms.tDepth.value = normalRT.depthTexture;
    stylePass.uniforms.resolution.value.copy(bufSize);
  }
  const bg = scene.background, fog = scene.fog;
  scene.background = null; scene.fog = null; scene.overrideMaterial = normalMat;
  renderer.setRenderTarget(normalRT);
  renderer.setClearColor(0x8080ff, 1);
  renderer.clear();
  renderer.render(scene, camera);
  renderer.setRenderTarget(null);
  scene.overrideMaterial = null; scene.background = bg; scene.fog = fog;
}

// ============================================================
// Styles
// ============================================================
function gradTex(steps, linear = false) {
  const data = new Uint8Array(steps.length * 4);
  steps.forEach((v, i) => data.set([v, v, v, 255], i * 4));
  const t = new THREE.DataTexture(data, steps.length, 1, THREE.RGBAFormat);
  t.minFilter = t.magFilter = linear ? THREE.LinearFilter : THREE.NearestFilter;
  t.needsUpdate = true;
  return t;
}
const celGrad = gradTex([90, 180, 255]);
const softGrad = gradTex([120, 165, 210, 255], true);

const glow = (hex, k) => new THREE.Color(hex).multiplyScalar(k);
const UNLIT = new Set(['lane', 'path']);

const STYLES = [
  {
    name: '赛璐珞 Cel',
    ref: '《塞尔达：旷野之息》《原神》《Hi-Fi Rush》',
    feat: '2-3 阶硬明暗 + 黑色描边 + 高饱和配色',
    pros: '辨识度高，车辆/障碍物轮廓非常清晰',
    cons: '描边后处理有一定开销',
    bg: 0x8fd3ff, fog: [150, 450], tone: THREE.NoToneMapping, exposure: 1,
    sun: [0xfff6e8, 2.6], hemi: [0xdff3ff, 0x6a8a5a, 1.2],
    palette: { ground: 0x7cc35b, road: 0x5a5f6b, shoulder: 0xc9c2b0, lane: 0xffffff, advBody: 0xff5a3c,
      advAccent: 0x222222, obsBody: 0x3a8dde, glass: 0x9fd8ff, wheel: 0x222222, leaf: 0x3fae4a,
      trunk: 0x8a5a3b, building: 0xf1e4c8, roof: 0xd9644a, path: 0xffd23f, cone: 0xff7a1a },
    mat: (role, c) => (UNLIT.has(role) ? new THREE.MeshBasicMaterial({ color: c }) : new THREE.MeshToonMaterial({ color: c, gradientMap: celGrad })),
    post: { edgeStrength: 1, edgeWidth: 1.5, edgeColor: 0x111111, saturation: 1.15, vignette: 0.2 },
    bloom: 0,
  },
  {
    name: '低多边形清新 Low-poly',
    ref: '《Mini Motorways》《纪念碑谷》《Townscaper》',
    feat: '平面着色 + 马卡龙配色 + 柔和阴影，无描边',
    pros: '最轻量，信息干净，适合长时间使用',
    cons: '远处层次感偏弱',
    bg: 0xcfe8f3, fog: [100, 380], tone: THREE.NeutralToneMapping, exposure: 1.05,
    sun: [0xffffff, 2.8], hemi: [0xeaf6ff, 0xb5c9a8, 1.4],
    palette: { ground: 0xa8d5a2, road: 0x7d8597, shoulder: 0xe8dcc4, lane: 0xfdfdfd, advBody: 0xff8c69,
      advAccent: 0x4a4a55, obsBody: 0x7fb7e6, glass: 0xd6eef8, wheel: 0x4a4a55, leaf: 0x6cc08b,
      trunk: 0xb08968, building: 0xf7e1d7, roof: 0xe5989b, path: 0xffb703, cone: 0xfb8500 },
    mat: (role, c) => (UNLIT.has(role) ? new THREE.MeshBasicMaterial({ color: c }) : new THREE.MeshStandardMaterial({ color: c, flatShading: true, roughness: 1, metalness: 0 })),
    post: { edgeStrength: 0, saturation: 1.0, vignette: 0.15 },
    bloom: 0,
  },
  {
    name: '吉卜力手绘 Painterly',
    ref: '吉卜力动画背景、《二之国》《Tchia》',
    feat: '柔和多阶光照 + Kuwahara 油画滤镜 + 暖色描边 + 纸张颗粒',
    pros: '艺术感最强',
    cons: 'GPU 开销最大，细线（车道线/曲线）会被抹软',
    bg: 0xb9dcec, fog: [90, 400], tone: THREE.NeutralToneMapping, exposure: 1.05,
    sun: [0xfff0d6, 2.8], hemi: [0xe6f2ff, 0x8a7a5a, 1.3],
    palette: { ground: 0x8fbf5a, road: 0x6e6a73, shoulder: 0xd8c9a3, lane: 0xf4efe1, advBody: 0xe0503a,
      advAccent: 0x3b3030, obsBody: 0x4f86b8, glass: 0xbfe3ee, wheel: 0x3a3333, leaf: 0x5a9e3a,
      trunk: 0x7a5236, building: 0xeedfc0, roof: 0xc4553e, path: 0xf2b632, cone: 0xf08a2c },
    mat: (role, c) => (UNLIT.has(role) ? new THREE.MeshBasicMaterial({ color: c }) : new THREE.MeshToonMaterial({ color: c, gradientMap: softGrad })),
    post: { edgeStrength: 0.6, edgeWidth: 1.0, edgeColor: 0x4a3426, kuwahara: 1, saturation: 1.1, vignette: 0.3, grain: 0.04 },
    bloom: 0.25, bloomThreshold: 0.85, bloomRadius: 0.6,
  },
  {
    name: '墨线素描 Ink',
    ref: '《Return of the Obra Dinn》、漫画分镜、工程手稿',
    feat: '单色纸张 + 排线阴影，仅 ADV/规划路径/锥桶红色强调',
    pros: '重点极其突出，适合讲解与截图',
    cons: '难以区分多种障碍物类型',
    bg: 0xf2ede0, fog: [140, 450], tone: THREE.NoToneMapping, exposure: 1,
    sun: [0xffffff, 2.6], hemi: [0xffffff, 0x888888, 1.1],
    palette: { ground: 0xe8e4da, road: 0x9a978f, shoulder: 0xcfcabd, lane: 0xffffff, advBody: 0xd7263d,
      advAccent: 0x222222, obsBody: 0xb8b4ab, glass: 0xdedad0, wheel: 0x333333, leaf: 0xa9a59b,
      trunk: 0x6e6a62, building: 0xd9d4c8, roof: 0x8e8a80, path: 0xd7263d, cone: 0xd7263d },
    mat: (role, c) => (UNLIT.has(role) ? new THREE.MeshBasicMaterial({ color: c }) : new THREE.MeshLambertMaterial({ color: c })),
    post: { edgeStrength: 1, edgeWidth: 1.2, edgeColor: 0x1a1a1a, ink: 1, paperColor: 0xf3eee2, accentColor: 0xd7263d },
    bloom: 0,
  },
  {
    name: '科技感 Tech HUD',
    ref: 'Tesla FSD 可视化、Waymo、Apollo Dreamview',
    feat: '暗色场景 + 发光车道线与轨迹 + Bloom',
    pros: '最贴近自动驾驶行业审美，轨迹可读性最好',
    cons: '"艺术感"偏弱',
    bg: 0x0b0d12, fog: [60, 320], tone: THREE.ACESFilmicToneMapping, exposure: 1.0,
    sun: [0xbfd4ff, 1.6], hemi: [0x8090b0, 0x101015, 0.8],
    palette: { ground: 0x15171c, road: 0x23262d, shoulder: 0x1b1d22, lane: 0xcfd8e6, advBody: 0xf2f4f8,
      advAccent: 0x2ea8ff, obsBody: 0x8a93a6, glass: 0x101318, wheel: 0x0b0c0f, leaf: 0x1f2a33,
      trunk: 0x1a1f25, building: 0x2a2f38, roof: 0x3a4150, path: 0x2ea8ff, cone: 0xff8a3d },
    mat: (role, c) => {
      if (role === 'path') return new THREE.MeshBasicMaterial({ color: glow(c, 2) });
      if (role === 'lane') return new THREE.MeshBasicMaterial({ color: glow(c, 0.9) });
      if (role === 'advAccent' || role === 'cone') return new THREE.MeshBasicMaterial({ color: glow(c, 2) });
      if (role === 'obsBody') return new THREE.MeshStandardMaterial({ color: c, roughness: 0.5, transparent: true, opacity: 0.8 });
      if (role === 'advBody') return new THREE.MeshStandardMaterial({ color: c, roughness: 0.35, emissive: 0x223344 });
      return new THREE.MeshStandardMaterial({ color: c, roughness: 0.9 });
    },
    post: { edgeStrength: 0.5, edgeWidth: 1.0, edgeColor: 0x6a7a90, saturation: 1.0, vignette: 0.35 },
    bloom: 0.55, bloomThreshold: 0.95, bloomRadius: 0.3,
  },
];

const POST_DEFAULTS = { edgeStrength: 0, edgeWidth: 1, edgeColor: 0x000000, kuwahara: 0, ink: 0,
  paperColor: 0xffffff, accentColor: 0xff0000, saturation: 1, vignette: 0, grain: 0 };

const btns = document.getElementById('btns');
const desc = document.getElementById('desc');
STYLES.forEach((st, i) => {
  const b = document.createElement('button');
  b.textContent = `${i + 1}. ${st.name}`;
  b.onclick = () => applyStyle(i);
  btns.appendChild(b);
});

function applyStyle(i) {
  const st = STYLES[i];
  if (!st.mats) {
    st.mats = {};
    for (const [role, c] of Object.entries(st.palette)) st.mats[role] = st.mat(role, c);
  }
  scene.traverse((o) => { if (o.isMesh && o.userData.role) o.material = st.mats[o.userData.role]; });
  scene.background = new THREE.Color(st.bg);
  scene.fog = new THREE.Fog(st.bg, st.fog[0], st.fog[1]);
  sun.color.set(st.sun[0]); sun.intensity = st.sun[1];
  hemi.color.set(st.hemi[0]); hemi.groundColor.set(st.hemi[1]); hemi.intensity = st.hemi[2];
  renderer.toneMapping = st.tone;
  renderer.toneMappingExposure = st.exposure;

  const p = { ...POST_DEFAULTS, ...st.post };
  const u = stylePass.uniforms;
  for (const k of ['edgeStrength', 'edgeWidth', 'kuwahara', 'ink', 'saturation', 'vignette', 'grain']) u[k].value = p[k];
  for (const k of ['edgeColor', 'paperColor', 'accentColor']) u[k].value.set(p[k]);

  bloom.enabled = st.bloom > 0;
  bloom.strength = st.bloom;
  bloom.threshold = st.bloomThreshold ?? 0.9;
  bloom.radius = st.bloomRadius ?? 0.4;

  [...btns.children].forEach((b, j) => b.classList.toggle('active', j === i));
  desc.innerHTML = `<b>${st.name}</b><br/>
    <span class="k">参考：</span>${st.ref}<br/>
    <span class="k">特征：</span>${st.feat}<br/>
    <span class="k">优点：</span>${st.pros}<br/>
    <span class="k">缺点：</span>${st.cons}`;
}

// ============================================================
// Loop / input
// ============================================================
let t = 0, paused = false, follow = false;
const target0 = frenet(95, 0);
controls.target.copy(target0);
camera.position.copy(target0).add(new THREE.Vector3(-38, 30, 42));

addEventListener('keydown', (e) => {
  const n = parseInt(e.key, 10);
  if (n >= 1 && n <= STYLES.length) applyStyle(n - 1);
  else if (e.code === 'Space') paused = !paused;
  else if (e.key === 'f' || e.key === 'F') follow = !follow;
});

addEventListener('resize', () => {
  const w = innerWidth, h = innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  composer.setSize(w, h);
});

const clock = new THREE.Clock();
const prevAdv = new THREE.Vector3();
function tick() {
  const dt = Math.min(clock.getDelta(), 0.05);
  if (!paused) t += dt;
  const T = (S_END - S_START) / ADV_V;
  const tt = t % T;

  prevAdv.copy(adv.position);
  place(adv, S_START + ADV_V * tt, advL);
  for (const o of obs) place(o.car, o.s0 + o.v * tt, o.l);

  if (follow) {
    const delta = adv.position.clone().sub(prevAdv);
    if (delta.length() < 5) { camera.position.add(delta); controls.target.add(delta); }
    else { controls.target.copy(adv.position); }
  }
  controls.update();
  stylePass.uniforms.time.value = t;

  renderNormals();
  composer.render();
  requestAnimationFrame(tick);
}

applyStyle(0);
tick();
