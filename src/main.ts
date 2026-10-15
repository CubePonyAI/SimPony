import GUI, { type Controller } from 'lil-gui';
import * as THREE from 'three';
import { ReferenceLine } from './core/referenceLine';
import {
  buildObstacle,
  compileScenario,
  defaultScenario,
  laneChangePath,
  laneKeepPath,
  laneNames,
  obstacleQuickOf,
  type CompiledScenario,
} from './core/scenario';
import { DEFAULT_CAR, type AgentSpec, type Scenario } from './core/types';
import { PathEditor } from './editor/pathEditor';
import { StEditor, type Series } from './editor/stEditor';
import { exportScenario, exportSimLog, parseScenario, pickFile } from './io/scenarioIO';
import { CameraRig, type CameraMode } from './render/cameras';
import { SceneView, type OverlayOptions } from './render/sceneView';
import { LOW_POLY, STYLES } from './render/styles';
import { analyzeReference, frameAt, simulate, type RefSeries, type SimResult } from './sim/simulate';
import { computeOccupancy, type OccupancyCell } from './sim/stOccupancy';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

class App {
  private scn: Scenario = defaultScenario();
  private ref = new ReferenceLine(this.scn.road.refPoints);
  private compiled!: CompiledScenario;
  private sim!: SimResult;
  private occupancy: OccupancyCell[] = [];
  private refSeries!: RefSeries;

  private selected = -1; // -1 = ADV, otherwise obstacle index
  private activeHandle = -1;
  private time = 0;
  private lastShownTime = -1;
  private playing = false;
  private speed = 1;
  private dirty = false;
  private readonly opts: OverlayOptions = { showGhost: true, showTrace: true, showObsPaths: true };

  private readonly viewportEl = $<HTMLDivElement>('viewport');
  private readonly renderer = new THREE.WebGLRenderer({ antialias: true });
  private readonly view: SceneView;
  private readonly rig: CameraRig;
  private readonly st: StEditor;
  private readonly gui: GUI;
  private selectCtl?: Controller;
  private objFolder?: GUI;

  private readonly slider = $<HTMLInputElement>('time-slider');
  private readonly timeLabel = $<HTMLSpanElement>('time-label');
  private readonly playBtn = $<HTMLButtonElement>('btn-play');
  private readonly statusEl = $<HTMLDivElement>('status');

  constructor() {
    const r = this.renderer;
    r.setPixelRatio(Math.min(devicePixelRatio, 2));
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFShadowMap;
    this.viewportEl.prepend(r.domElement);

    this.view = new SceneView(r, LOW_POLY);
    this.rig = new CameraRig(r.domElement, 1);
    this.st = new StEditor($<HTMLCanvasElement>('st-canvas'), {
      changed: () => (this.dirty = true),
      seek: (t) => this.seek(t),
    });

    new PathEditor({
      dom: r.domElement,
      camera: () => this.rig.active,
      handles: () => this.view.handleGroup,
      ref: () => this.ref,
      road: () => this.scn.road,
      enabled: () => this.rig.mode !== 'adv',
      points: () => this.selectedSpec().path,
      lockCamera: (on) => this.rig.lock(on),
      changed: () => (this.dirty = true),
      setActive: (i) => {
        this.activeHandle = i;
        this.refreshHandles();
      },
    });

    this.gui = new GUI({ title: 'SimPony', container: this.viewportEl });
    this.buildGui();
    this.bindDom();
    this.loadScenario(this.scn);

    new ResizeObserver(() => this.resize()).observe(this.viewportEl);
    this.resize();
    requestAnimationFrame(this.loop);
  }

  // ---------------- Scenario lifecycle ----------------

  private loadScenario(scn: Scenario) {
    this.scn = scn;
    this.ref = new ReferenceLine(scn.road.refPoints);
    this.selected = -1;
    this.time = 0;
    this.playing = false;
    this.view.buildWorld(this.ref, scn.road);
    this.view.setAgents(scn.adv, scn.obstacles);
    this.recompute();
    const s0 = this.compiled.adv.stateAt(0);
    this.rig.reset(this.advCenter(s0.x, s0.y, s0.yaw));
    this.rebuildGuiForScenario();
  }

  private agentsChanged() {
    this.view.setAgents(this.scn.adv, this.scn.obstacles);
    this.recompute();
  }

  private recompute() {
    this.dirty = false;
    this.compiled = compileScenario(this.scn, this.ref);
    this.sim = simulate(this.compiled, this.scn.sim);
    this.occupancy = computeOccupancy(this.compiled.adv, this.compiled.obstacles, this.sim.duration);
    this.refSeries = analyzeReference(this.compiled, this.sim.duration);
    this.view.setOverlays(this.compiled, this.scn.sim.mode === 'track' ? this.sim : null, this.selected, this.opts);
    this.refreshHandles();
    this.refreshStData();
    this.slider.max = String(this.sim.duration);
    this.time = Math.min(this.time, this.sim.duration);
    this.lastShownTime = -1;
  }

  private selectedSpec(): AgentSpec {
    return this.selected < 0 ? this.scn.adv : this.scn.obstacles[this.selected];
  }

  private refreshHandles() {
    const pts = this.selectedSpec().path.map((p) => this.ref.toWorld(p.s, p.l));
    this.view.setHandles(pts, this.activeHandle);
  }

  private refreshStData() {
    const spec = this.selectedSpec();
    spec.st.sort((a, b) => a.t - b.t);
    const isAdv = this.selected < 0;
    const agent = isAdv ? this.compiled.adv : this.compiled.obstacles[this.selected];
    let ref: Series;
    if (isAdv) {
      ref = this.refSeries;
    } else {
      ref = { t: [], s: [], v: [], a: [] };
      for (let t = 0; t <= this.sim.duration + 1e-9; t += 0.05) {
        const m = agent.motion.at(t);
        ref.t.push(t);
        ref.s.push(m.s);
        ref.v.push(m.v);
        ref.a.push(m.a);
      }
    }
    let actual: Series | null = null;
    if (isAdv && this.scn.sim.mode === 'track') {
      actual = { t: [], s: [], v: [], a: [] };
      for (let i = 0; i < this.sim.frames.length; i += 2) {
        const f = this.sim.frames[i];
        actual.t.push(f.t);
        actual.s.push(f.adv.arc);
        actual.v.push(f.adv.v);
        actual.a.push(f.adv.a);
      }
    }
    this.st.setData({
      title: spec.name,
      knots: spec.st,
      pathLength: agent.path.length,
      duration: this.sim.duration,
      occupancy: isAdv ? this.occupancy : [],
      obstacleNames: this.scn.obstacles.map((o) => o.name),
      ref,
      actual,
      maxAccel: spec.vehicle.maxAccel,
      maxDecel: spec.vehicle.maxDecel,
    });
  }

  private advCenter(x: number, y: number, yaw: number) {
    const v = this.scn.adv.vehicle;
    const off = v.length / 2 - v.rearOverhang;
    return { x: x + off * Math.cos(yaw), y: y + off * Math.sin(yaw), yaw };
  }

  // ---------------- Time ----------------

  private seek(t: number) {
    this.time = Math.max(0, Math.min(t, this.sim.duration));
  }

  private setPlaying(on: boolean) {
    if (on && this.time >= this.sim.duration - 1e-6) this.time = 0;
    this.playing = on;
    this.playBtn.textContent = on ? '⏸' : '▶';
  }

  // ---------------- DOM / GUI ----------------

  private bindDom() {
    this.playBtn.onclick = () => this.setPlaying(!this.playing);
    $<HTMLButtonElement>('btn-reset').onclick = () => this.seek(0);
    this.slider.oninput = () => this.seek(parseFloat(this.slider.value));
    $<HTMLSelectElement>('speed-select').onchange = (e) => (this.speed = parseFloat((e.target as HTMLSelectElement).value));
    document.querySelectorAll<HTMLButtonElement>('#cam-bar button').forEach((b) => {
      b.onclick = () => this.setCamera(b.dataset.cam as CameraMode);
    });
    this.setCamera('third');
    addEventListener('keydown', (e) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if (e.code === 'Space') {
        e.preventDefault();
        this.setPlaying(!this.playing);
      } else if (e.key === '1') this.setCamera('top');
      else if (e.key === '2') this.setCamera('adv');
      else if (e.key === '3') this.setCamera('third');
    });
  }

  private setCamera(m: CameraMode) {
    this.rig.setMode(m);
    this.view.handleGroup.visible = m !== 'adv';
    $('hint').textContent = m === 'adv'
      ? '车内视角：左键拖动环顾驾驶舱 · 双击回正 · 仪表显示实际车速与转角'
      : '路径编辑：拖动控制点 · 双击路面添加 · 右键删除 · 按住 Shift 取消车道吸附';
    document.querySelectorAll<HTMLButtonElement>('#cam-bar button').forEach((b) => b.classList.toggle('active', b.dataset.cam === m));
  }

  private buildGui() {
    const gui = this.gui;
    const sim = () => this.scn.sim;

    const fScn = gui.addFolder('场景 / 导入导出');
    const io = {
      exportScn: () => exportScenario(this.scn),
      importScn: async () => {
        try {
          this.loadScenario(parseScenario(await pickFile('.json,application/json'), defaultScenario()));
        } catch (err) {
          alert((err as Error).message);
        }
      },
      exportLog: () => exportSimLog(this.sim),
      reset: () => this.loadScenario(defaultScenario()),
    };
    fScn.add(io, 'exportScn').name('导出场景 JSON');
    fScn.add(io, 'importScn').name('导入场景 JSON');
    fScn.add(io, 'exportLog').name('导出仿真日志 CSV');
    fScn.add(io, 'reset').name('重置为默认场景');
    fScn.close();

    // Simulation settings — proxies so loadScenario() swaps underlying object safely.
    const fSim = gui.addFolder('仿真');
    const simProxy = new Proxy({} as Scenario['sim'], {
      get: (_, k) => sim()[k as keyof Scenario['sim']],
      set: (_, k, v) => {
        (sim() as unknown as Record<string, unknown>)[k as string] = v;
        return true;
      },
    });
    const re = () => this.recompute();
    fSim.add(simProxy, 'mode', { 理想回放: 'replay', 控制跟踪: 'track' }).name('执行模式').onChange(re);
    fSim.add(simProxy, 'lateral', { 'Pure Pursuit': 'purePursuit', Stanley: 'stanley' }).name('横向控制器').onChange(re);
    fSim.add(simProxy, 'ppLookaheadGain', 0.1, 3, 0.05).name('PP 预瞄增益').onFinishChange(re);
    fSim.add(simProxy, 'ppMinLookahead', 1, 20, 0.5).name('PP 最小预瞄 [m]').onFinishChange(re);
    fSim.add(simProxy, 'stanleyGain', 0.1, 5, 0.1).name('Stanley 增益').onFinishChange(re);
    fSim.add(simProxy, 'lonKpS', 0, 3, 0.05).name('纵向 Kp(s)').onFinishChange(re);
    fSim.add(simProxy, 'lonKpV', 0, 5, 0.1).name('纵向 Kp(v)').onFinishChange(re);
    fSim.add(simProxy, 'dt', 0.005, 0.05, 0.005).name('步长 dt [s]').onFinishChange(re);
    fSim.add(simProxy, 'extraTime', 0, 10, 0.5).name('末尾延时 [s]').onFinishChange(re);

    const fView = gui.addFolder('显示');
    const style = { name: LOW_POLY.name };
    fView
      .add(style, 'name', STYLES.map((s) => s.name))
      .name('渲染风格')
      .onChange((n: string) => this.view.applyStyle(STYLES.find((s) => s.name === n) ?? LOW_POLY));
    fView.add(this.opts, 'showGhost').name('参考幽灵车').onChange(re);
    fView.add(this.opts, 'showTrace').name('实际轨迹').onChange(re);
    fView.add(this.opts, 'showObsPaths').name('障碍物路径').onChange(re);
    fView.add(this.rig, 'followTop').name('俯视跟随 ADV');
    fView.close();

    // ADV vehicle params
    const fVeh = gui.addFolder('ADV 车辆参数');
    const vp = new Proxy({} as typeof DEFAULT_CAR, {
      get: (_, k) => this.scn.adv.vehicle[k as keyof typeof DEFAULT_CAR],
      set: (_, k, v) => {
        this.scn.adv.vehicle[k as keyof typeof DEFAULT_CAR] = v;
        return true;
      },
    });
    const ag = () => this.agentsChanged();
    fVeh.add(vp, 'length', 3, 12, 0.1).name('车长 [m]').onFinishChange(ag);
    fVeh.add(vp, 'width', 1.4, 3, 0.05).name('车宽 [m]').onFinishChange(ag);
    fVeh.add(vp, 'height', 1.2, 4, 0.05).name('车高 [m]').onFinishChange(ag);
    fVeh.add(vp, 'wheelbase', 2, 7, 0.05).name('轴距 [m]').onFinishChange(ag);
    fVeh.add(vp, 'rearOverhang', 0.5, 3, 0.05).name('后悬 [m]').onFinishChange(ag);
    fVeh.add(vp, 'maxSteer', 10, 50, 1).name('最大前轮转角 [°]').onFinishChange(ag);
    fVeh.add(vp, 'maxSteerRate', 10, 200, 5).name('最大转角速率 [°/s]').onFinishChange(ag);
    fVeh.add(vp, 'maxAccel', 0.5, 8, 0.1).name('最大加速度').onFinishChange(ag);
    fVeh.add(vp, 'maxDecel', 0.5, 10, 0.1).name('最大减速度').onFinishChange(ag);
    fVeh.add(vp, 'maxLatAccel', 0.5, 8, 0.1).name('横向加速度上限').onFinishChange(ag);
    fVeh.add({ reset: () => (Object.assign(this.scn.adv.vehicle, DEFAULT_CAR), fVeh.controllersRecursive().forEach((c) => c.updateDisplay()), ag()) }, 'reset').name('恢复默认参数');
    fVeh.close();

    // ADV templates
    const fTpl = gui.addFolder('ADV 模板');
    const tpl = { kind: '左换道', fromLane: 1, sStart: 50, length: 40, speed: 10 };
    const lanes = () => Object.fromEntries(laneNames(this.scn.road).map((n, i) => [n, i]));
    fTpl.add(tpl, 'kind', ['保持车道', '左换道', '右换道']).name('路径模板');
    fTpl.add(tpl, 'fromLane', lanes()).name('起始车道');
    fTpl.add(tpl, 'sStart', 0, 300, 1).name('换道起点 s [m]');
    fTpl.add(tpl, 'length', 10, 150, 1).name('换道长度 [m]');
    fTpl
      .add(
        {
          apply: () => {
            const p = this.scn.adv.path;
            const s0 = p[0].s;
            const s1 = p[p.length - 1].s;
            const n = this.scn.road.laneCount;
            const to = tpl.kind === '左换道' ? Math.min(tpl.fromLane + 1, n - 1) : tpl.kind === '右换道' ? Math.max(tpl.fromLane - 1, 0) : tpl.fromLane;
            const sStart = Math.min(Math.max(tpl.sStart, s0 + 1), s1 - tpl.length - 1);
            this.scn.adv.path =
              to === tpl.fromLane
                ? laneKeepPath(this.scn.road, tpl.fromLane, s0, s1)
                : laneChangePath(this.scn.road, tpl.fromLane, to, s0, sStart, tpl.length, s1);
            this.recompute();
          },
        },
        'apply',
      )
      .name('应用路径模板');
    fTpl.add(tpl, 'speed', 1, 30, 0.5).name('匀速 v [m/s]');
    fTpl
      .add(
        {
          apply: () => {
            const len = this.compiled.adv.path.length;
            const T = len / tpl.speed;
            const n = Math.max(2, Math.ceil(T / 5));
            this.scn.adv.st = Array.from({ length: n + 1 }, (_, i) => ({ t: (T * i) / n, s: (len * i) / n }));
            this.recompute();
          },
        },
        'apply',
      )
      .name('应用匀速 s-t');
    fTpl.close();

    // Selection
    const fSel = gui.addFolder('编辑对象');
    const selObj = { target: -1 };
    this.selectCtl = fSel.add(selObj, 'target', {}).name('当前对象');
    fSel
      .add(
        {
          addCar: () => {
            const o = buildObstacle('car', this.scn.road, this.ref.length, { lane: 1, s0: 100, speed: 6 });
            o.name = `障碍车${this.scn.obstacles.length + 1}`;
            this.scn.obstacles.push(o);
            this.agentsChanged();
            this.select(this.scn.obstacles.length - 1);
          },
        },
        'addCar',
      )
      .name('+ 添加障碍车');
    fSel
      .add(
        {
          addCone: () => {
            const o = buildObstacle('cone', this.scn.road, this.ref.length, { lane: 1, s0: 150, speed: 0 });
            o.name = `锥桶${this.scn.obstacles.length + 1}`;
            this.scn.obstacles.push(o);
            this.agentsChanged();
            this.select(this.scn.obstacles.length - 1);
          },
        },
        'addCone',
      )
      .name('+ 添加锥桶');
    fSel
      .add(
        {
          del: () => {
            if (this.selected < 0) return;
            this.scn.obstacles.splice(this.selected, 1);
            this.selected = -1;
            this.agentsChanged();
            this.select(-1);
          },
        },
        'del',
      )
      .name('删除选中障碍物');
  }

  private rebuildGuiForScenario() {
    this.gui.controllersRecursive().forEach((c) => c.updateDisplay());
    this.select(this.selected);
  }

  private select(i: number) {
    this.selected = i;
    this.activeHandle = -1;
    const opts: Record<string, number> = { ADV: -1 };
    this.scn.obstacles.forEach((o, k) => (opts[`${k + 1}. ${o.name}`] = k));
    const parent = this.selectCtl!.parent;
    const holder = { target: i };
    this.selectCtl!.destroy();
    this.selectCtl = parent.add(holder, 'target', opts).name('当前对象').onChange((v: number) => this.select(v));
    // keep selector first in its folder
    parent.$children.prepend(this.selectCtl.domElement);

    this.objFolder?.destroy();
    this.objFolder = undefined;
    if (i >= 0) this.buildObstacleFolder(parent, i);
    this.recompute();
  }

  private buildObstacleFolder(parent: GUI, i: number) {
    const spec = this.scn.obstacles[i];
    const f = parent.addFolder(`选中: ${spec.name}`);
    this.objFolder = f;
    const q = obstacleQuickOf(this.scn.road, spec);
    const lanes = Object.fromEntries(laneNames(this.scn.road).map((n, k) => [n, k]));
    const regen = () => {
      Object.assign(spec, buildObstacle(spec.kind as 'car' | 'cone', this.scn.road, this.ref.length, q, spec));
      this.recompute();
    };
    f.add(spec, 'name').name('名称').onFinishChange(() => this.select(i));
    f.add(q, 'lane', lanes).name('车道').onChange(regen);
    f.add(q, 's0', 0, Math.floor(this.ref.length - 2), 1).name('起点 s [m]').onFinishChange(regen);
    if (spec.kind !== 'cone') f.add(q, 'speed', 0, 30, 0.5).name('匀速 v [m/s]').onFinishChange(regen);
    if (spec.kind !== 'cone') {
      const ag = () => this.agentsChanged();
      f.add(spec.vehicle, 'length', 3, 18, 0.1).name('车长 [m]').onFinishChange(ag);
      f.add(spec.vehicle, 'width', 1.4, 3, 0.05).name('车宽 [m]').onFinishChange(ag);
    }
  }

  // ---------------- Frame loop ----------------

  private resize() {
    const w = this.viewportEl.clientWidth;
    const h = this.viewportEl.clientHeight;
    if (w === 0 || h === 0) return;
    this.renderer.setSize(w, h, false);
    this.rig.resize(w / h);
  }

  private prevNow = performance.now();
  private loop = (now: number) => {
    const dt = Math.min((now - this.prevNow) / 1000, 0.1);
    this.prevNow = now;
    if (this.dirty) this.recompute();

    if (this.playing) {
      this.time += dt * this.speed;
      if (this.time >= this.sim.duration) {
        this.time = this.sim.duration;
        this.setPlaying(false);
      }
    }
    const timeMoved = this.time !== this.lastShownTime;
    this.lastShownTime = this.time;

    const f = frameAt(this.sim, this.time);
    this.view.updateFrame(f, this.opts, this.selected);
    const c = this.advCenter(f.adv.x, f.adv.y, f.adv.yaw);
    this.rig.update(c, this.scn.adv.vehicle, timeMoved);

    this.renderer.render(this.view.scene, this.rig.active);

    this.st.setTime(this.time);
    this.st.draw();
    if (document.activeElement !== this.slider) this.slider.value = String(this.time);
    this.timeLabel.textContent = `${this.time.toFixed(2)} s`;
    this.updateStatus(f);
    requestAnimationFrame(this.loop);
  };

  private updateStatus(f: ReturnType<typeof frameAt>) {
    const a = f.adv;
    const vp = this.scn.adv.vehicle;
    const r = this.refSeries;
    const bad = (cond: boolean, s: string) => (cond ? `<span class="bad">${s}</span>` : s);
    const lines = [
      `t ${f.t.toFixed(2)} s   模式 ${this.scn.sim.mode === 'track' ? '控制跟踪' : '理想回放'}`,
      `v ${(a.v * 3.6).toFixed(1)} km/h   a ${a.a.toFixed(2)} m/s²   δ ${((a.steer * 180) / Math.PI).toFixed(1)}°`,
      `横向误差 ${a.latErr.toFixed(2)} m   纵向误差 ${a.lonErr.toFixed(2)} m`,
      `最大误差 横 ${this.sim.maxLatErr.toFixed(2)} / 纵 ${this.sim.maxLonErr.toFixed(2)} m`,
      bad(f.collisions.length > 0, `碰撞 ${f.collisions.length ? '是 ← ' + f.collisions.map((i) => esc(this.scn.obstacles[i]?.name ?? '')).join(',') : '否'}`) +
        (this.sim.firstCollision ? `   <span class="bad">首次碰撞 @${this.sim.firstCollision.t.toFixed(2)}s</span>` : ''),
      '— 参考轨迹可行性 —',
      bad(r.maxAccel > vp.maxAccel, `最大加速 ${r.maxAccel.toFixed(2)} / ${vp.maxAccel}`) +
        '   ' +
        bad(r.maxDecel > vp.maxDecel, `最大减速 ${r.maxDecel.toFixed(2)} / ${vp.maxDecel}`),
      bad(r.maxLatAccel > vp.maxLatAccel, `横向加速 ${r.maxLatAccel.toFixed(2)} / ${vp.maxLatAccel}`) +
        '   ' +
        bad(r.maxSteerNeeded > vp.maxSteer, `所需转角 ${r.maxSteerNeeded.toFixed(1)}° / ${vp.maxSteer}°`),
    ];
    const last = this.scn.adv.st[this.scn.adv.st.length - 1];
    if (last && last.s > this.compiled.adv.path.length + 0.5) lines.push(bad(true, 's-t 终点超出路径长度'));
    const html = lines.join('\n');
    if (this.lastStatus !== html) {
      this.lastStatus = html;
      this.statusEl.innerHTML = html;
    }
  }
  private lastStatus = '';
}

new App();
