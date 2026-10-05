// Babylon.js side. One vertex pool for the whole model is allocated once and
// filled range by range as archives decode; every instance of the model is a
// mesh that shares that pool. With Tessera on, each instance owns an index
// buffer that holds its cut, re-selected for its own object-space camera. With
// Tessera off, every instance draws the full-resolution geometry from one
// shared index buffer, which is what a renderer without cluster LOD would do.

import "@babylonjs/core/Engines/Extensions/engine.dynamicBuffer";
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { Engine } from "@babylonjs/core/Engines/engine";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { Geometry } from "@babylonjs/core/Meshes/geometry";
import { Buffer, VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { BoundingInfo } from "@babylonjs/core/Culling/boundingInfo";
import { Scene } from "@babylonjs/core/scene";
import type { CutStats, Runtime, ViewParams } from "./runtime";

export type Mode = "lod" | "full";

export interface FrameInfo {
  stats: CutStats;
  /** Selection time spent this frame, all instances. */
  selectMs: number;
  uploadMs: number;
  drawCalls: number;
  mode: Mode;
  /** Instances whose cut still has to be refreshed for the current camera. */
  pendingInstances: number;
}

interface Instance {
  world: Matrix;
  worldInv: Matrix;
  viewProj: Float32Array;
  lodMesh: Mesh;
  lodGeo: Geometry;
  fullMesh: Mesh;
  translucent: boolean;
  capacity: number;
  dirty: boolean;
  cutLen: number;
  cutHash: number;
  stats: CutStats;
}

const EMPTY_STATS: CutStats = { clusters: 0, triangles: 0, culled: 0, loadedClusters: 0, loadedTriangles: 0, pendingRefinement: 0, coarsestLevelInCut: 0 };
const INITIAL_INDEX_CAPACITY = 300_000;

/** Deterministic layout, so a benchmark run is the same scene every time. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Viewer {
  readonly engine: Engine;
  readonly scene: Scene;
  readonly camera: ArcRotateCamera;
  readonly rock: StandardMaterial;
  readonly ice: StandardMaterial;
  private runtime: Runtime | null = null;
  private sun: DirectionalLight;
  private positionBuffer: Buffer | null = null;
  private normalBuffer: Buffer | null = null;
  private colorBuffer: Buffer | null = null;
  private fullGeo: Geometry | null = null;
  private fullAnchor: Mesh | null = null;
  private fullDirty = true;
  private fullStats: CutStats = EMPTY_STATS;
  private instances: Instance[] = [];
  private cursor = 0;
  private lastVp = new Float32Array(16);
  private lastCamPos = new Vector3(NaN, NaN, NaN);
  private vpScratch = new Matrix();
  private camObj = new Vector3();
  private vertexColorsOn = false;
  private modelDiag = 1;
  private frameWaiters: Array<(f: FrameInfo | null) => void> = [];
  private _mode: Mode = "lod";
  private _instanceCount = 27;
  private _translucentEvery = 3;
  private _thresholdPx = 1;
  private _frustumCull = true;
  /** Selection budget per frame; instances past it wait for the next frame. */
  selectBudgetMs = 6;
  freezeCut = false;
  onFrame: ((f: FrameInfo) => void) | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.engine = new Engine(canvas, true, { preserveDrawingBuffer: false, stencil: false, antialias: true }, true);
    this.scene = new Scene(this.engine);
    this.scene.clearColor = new Color4(0.055, 0.067, 0.09, 1);
    this.scene.skipFrustumClipping = true;

    this.camera = new ArcRotateCamera("cam", -Math.PI / 2.4, Math.PI / 2.6, 3, Vector3.Zero(), this.scene);
    this.camera.attachControl(canvas, true);
    this.camera.wheelDeltaPercentage = 0.02;
    this.camera.pinchDeltaPercentage = 0.02;
    this.camera.fov = 0.9;

    const hemi = new HemisphericLight("hemi", new Vector3(0, 1, 0), this.scene);
    hemi.intensity = 0.6;
    hemi.groundColor = new Color3(0.18, 0.16, 0.2);
    this.sun = new DirectionalLight("sun", new Vector3(-0.5, -1, -0.3), this.scene);
    this.sun.intensity = 1.05;

    this.rock = new StandardMaterial("rock", this.scene);
    this.rock.diffuseColor = new Color3(0.84, 0.82, 0.78);
    this.rock.specularColor = new Color3(0.08, 0.08, 0.08);
    this.rock.backFaceCulling = true;

    // Translucent instances: alpha blending behind a depth pre-pass, so only the
    // nearest surface blends and the surface reads as glass. Both passes scale
    // with the triangle count, which is what a benchmark wants. This looks right
    // for a near-convex model like the asteroid; a concave model shows its
    // nearest shell only, so translucency is off by default for loaded models.
    this.ice = new StandardMaterial("ice", this.scene);
    this.ice.diffuseColor = new Color3(0.72, 0.86, 1.0);
    this.ice.specularColor = new Color3(0.6, 0.65, 0.7);
    this.ice.specularPower = 40;
    this.ice.emissiveColor = new Color3(0.1, 0.17, 0.26);
    this.ice.alpha = 0.55;
    this.ice.backFaceCulling = true;
    this.ice.needDepthPrePass = true;

    this.engine.runRenderLoop(() => this.frame());
    window.addEventListener("resize", () => this.engine.resize());
  }

  get mode(): Mode { return this._mode; }
  set mode(m: Mode) {
    if (m === this._mode) return;
    this._mode = m;
    for (const inst of this.instances) {
      inst.lodMesh.setEnabled(m === "lod");
      inst.fullMesh.setEnabled(m === "full");
    }
    this.markDirty();
  }

  get instanceCount(): number { return this._instanceCount; }
  set instanceCount(n: number) {
    this._instanceCount = Math.max(1, n | 0);
    if (this.runtime) this.rebuildInstances();
  }

  /** Every n-th instance is translucent; 0 = none. */
  get translucentEvery(): number { return this._translucentEvery; }
  set translucentEvery(n: number) {
    this._translucentEvery = n;
    if (this.runtime) this.rebuildInstances();
  }

  get thresholdPx(): number { return this._thresholdPx; }
  set thresholdPx(px: number) { this._thresholdPx = px; this.markDirty(); }

  get frustumCull(): boolean { return this._frustumCull; }
  set frustumCull(on: boolean) { this._frustumCull = on; this.markDirty(); }

  set clusterColors(on: boolean) {
    this.vertexColorsOn = on;
    for (const inst of this.instances) {
      inst.lodMesh.useVertexColors = on;
      inst.fullMesh.useVertexColors = on;
    }
    this.rock.diffuseColor = on ? new Color3(1, 1, 1) : new Color3(0.84, 0.82, 0.78);
    this.ice.diffuseColor = on ? new Color3(0.9, 0.95, 1) : new Color3(0.72, 0.86, 1.0);
  }

  /** Install a model: (re)allocates the GPU pool for its manifest and lays the instances out. */
  setRuntime(runtime: Runtime): void {
    this.disposeInstances();
    this.fullAnchor?.dispose(false, false);
    this.fullAnchor = null;
    this.fullGeo = null;
    this.positionBuffer?.dispose();
    this.normalBuffer?.dispose();
    this.colorBuffer?.dispose();
    this.runtime = runtime;

    const n = runtime.manifest.totalVertices;
    this.positionBuffer = new Buffer(this.engine, new Float32Array(n * 3), true, 3);
    this.normalBuffer = new Buffer(this.engine, new Float32Array(n * 3), true, 3);
    this.colorBuffer = new Buffer(this.engine, new Uint8Array(n * 4), true, 4, false, false, true);

    const b = runtime.manifest.aabb;
    this.modelDiag = Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) || 1;

    // The full-resolution geometry every instance shares when Tessera is off.
    // A disabled anchor mesh keeps it alive while instances come and go.
    this.fullGeo = this.makeGeometry(runtime.manifest.totalTriangles * 3);
    this.fullAnchor = new Mesh("full-anchor", this.scene);
    this.fullGeo.applyToMesh(this.fullAnchor);
    this.fullAnchor.setEnabled(false);
    this.fullDirty = true;
    this.fullStats = EMPTY_STATS;

    this.rebuildInstances();
  }

  /** Geometry over the shared pool with its own index buffer of `indexCapacity` entries. */
  private makeGeometry(indexCapacity: number): Geometry {
    const runtime = this.runtime as Runtime;
    const n = runtime.manifest.totalVertices;
    const b = runtime.manifest.aabb;
    const geo = new Geometry(Geometry.RandomId(), this.scene, undefined, true);
    // Bounds come from the manifest; scanning 2M vertices per instance would be pointless.
    geo.useBoundingInfoFromGeometry = true;
    geo._boundingInfo = new BoundingInfo(new Vector3(...b.min), new Vector3(...b.max));
    geo.setVerticesBuffer((this.positionBuffer as Buffer).createVertexBuffer(VertexBuffer.PositionKind, 0, 3), n, false);
    geo.setVerticesBuffer((this.normalBuffer as Buffer).createVertexBuffer(VertexBuffer.NormalKind, 0, 3), n, false);
    geo.setVerticesBuffer(new VertexBuffer(this.engine, this.colorBuffer as Buffer, VertexBuffer.ColorKind, true, false, 4, false, 0, 4, VertexBuffer.UNSIGNED_BYTE, true), n, false);
    geo.setIndices(new Uint32Array(indexCapacity), n, true);
    return geo;
  }

  private attach(name: string, geo: Geometry): Mesh {
    const mesh = new Mesh(name, this.scene);
    geo.applyToMesh(mesh);
    mesh.alwaysSelectAsActiveMesh = true;
    mesh.useVertexColors = this.vertexColorsOn;
    this.resetSubMesh(mesh, 0);
    return mesh;
  }

  /**
   * The one sub-mesh covers `indexCount` indices of the buffer. Once it is no
   * longer "global" Babylon wants bounds of its own (alpha sorting reads them),
   * so it gets the model's bounds instead of a scan over the index buffer.
   */
  private resetSubMesh(mesh: Mesh, indexCount: number): void {
    const b = (this.runtime as Runtime).manifest.aabb;
    const sm = mesh.subMeshes[0];
    sm.indexCount = indexCount;
    sm.setBoundingInfo(new BoundingInfo(new Vector3(...b.min), new Vector3(...b.max)));
  }

  private disposeInstances(): void {
    for (const inst of this.instances) {
      inst.lodMesh.dispose(false, false);
      inst.fullMesh.dispose(false, false);
    }
    this.instances = [];
  }

  /** Lays `instanceCount` copies of the model out on a jittered grid around the origin. */
  private rebuildInstances(): void {
    const runtime = this.runtime as Runtime;
    this.disposeInstances();
    const n = this._instanceCount;
    const b = runtime.manifest.aabb;
    const center = new Vector3((b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2);
    const spacing = this.modelDiag * 1.45;
    const side = n <= 1 ? 1 : n <= 9 ? Math.ceil(Math.sqrt(n)) : Math.ceil(Math.cbrt(n));
    const layers = n <= 9 ? 1 : side;
    const rnd = mulberry32(1234);
    const fieldMin = new Vector3(Infinity, Infinity, Infinity);
    const fieldMax = new Vector3(-Infinity, -Infinity, -Infinity);

    for (let i = 0; i < n; i++) {
      const gx = i % side;
      const gz = Math.floor(i / side) % side;
      const gy = Math.floor(i / (side * side)) % layers;
      const jitter = () => (rnd() - 0.5) * 0.5 * spacing;
      const pos = n === 1
        ? Vector3.Zero()
        : new Vector3((gx - (side - 1) / 2) * spacing + jitter(), (gy - (layers - 1) / 2) * spacing + jitter(), (gz - (side - 1) / 2) * spacing + jitter());
      const scale = n === 1 ? 1 : 0.75 + rnd() * 0.55;
      const rot = n === 1 ? Quaternion.Identity() : Quaternion.FromEulerAngles(rnd() * Math.PI * 2, rnd() * Math.PI * 2, rnd() * Math.PI * 2);
      // Drawn from the same seeded sequence, so the mix is fixed but not aligned with the grid.
      const translucent = this._translucentEvery > 0 && n > 1 && rnd() < 1 / this._translucentEvery;

      const lodGeo = this.makeGeometry(INITIAL_INDEX_CAPACITY);
      const lodMesh = this.attach(`lod-${i}`, lodGeo);
      const fullMesh = this.attach(`full-${i}`, this.fullGeo as Geometry);
      for (const m of [lodMesh, fullMesh]) {
        m.position = pos;
        m.rotationQuaternion = rot;
        m.scaling = new Vector3(scale, scale, scale);
        m.material = translucent ? this.ice : this.rock;
        m.computeWorldMatrix(true);
      }
      lodMesh.setEnabled(this._mode === "lod");
      fullMesh.setEnabled(this._mode === "full");
      fullMesh.subMeshes[0].indexCount = this.fullStats.triangles * 3;

      const world = lodMesh.getWorldMatrix().clone();
      this.instances.push({
        world,
        worldInv: world.clone().invert(),
        viewProj: new Float32Array(16),
        lodMesh,
        lodGeo,
        fullMesh,
        translucent,
        capacity: INITIAL_INDEX_CAPACITY,
        dirty: true,
        cutLen: -1,
        cutHash: 0,
        stats: EMPTY_STATS
      });

      const r = (this.modelDiag / 2) * scale;
      const c = Vector3.TransformCoordinates(center, world);
      fieldMin.minimizeInPlace(new Vector3(c.x - r, c.y - r, c.z - r));
      fieldMax.maximizeInPlace(new Vector3(c.x + r, c.y + r, c.z + r));
    }
    this.frameCamera(fieldMin, fieldMax);
    this.cursor = 0;
  }

  private frameCamera(min: Vector3, max: Vector3): void {
    const diag = Vector3.Distance(min, max) || 1;
    const cam = this.camera;
    cam.target = min.add(max).scale(0.5);
    cam.radius = diag * (this._instanceCount === 1 ? 1.4 : 0.8);
    cam.alpha = -Math.PI / 2.4;
    cam.beta = this._instanceCount === 1 ? Math.PI / 2.6 : Math.PI / 2.3;
    cam.lowerRadiusLimit = this.modelDiag * 0.02;
    cam.upperRadiusLimit = diag * 8;
    cam.minZ = this.modelDiag * 0.002;
    cam.maxZ = diag * 30;
    cam.panningSensibility = 2000 / diag;
    this.lastCamPos.set(NaN, NaN, NaN);
  }

  /** Upload a freshly decoded pool range to the GPU. */
  uploadRange(first: number, count: number): number {
    if (count === 0 || !this.runtime || !this.positionBuffer) return 0;
    const t0 = performance.now();
    const pos = this.runtime.positions().subarray(first * 3, (first + count) * 3);
    const nrm = this.runtime.normals().subarray(first * 3, (first + count) * 3);
    const col = this.runtime.colors().subarray(first * 4, (first + count) * 4);
    this.positionBuffer.updateDirectly(pos, first * 3 * 4, undefined, true);
    (this.normalBuffer as Buffer).updateDirectly(nrm, first * 3 * 4, undefined, true);
    (this.colorBuffer as Buffer).updateDirectly(col, first * 4, undefined, true);
    return performance.now() - t0;
  }

  /** View for the model at the origin (what the decode/select benchmark uses). */
  viewParams(): ViewParams {
    const cam = this.camera;
    const vp = cam.getViewMatrix().multiply(cam.getProjectionMatrix());
    const p = cam.globalPosition;
    return {
      position: [p.x, p.y, p.z],
      viewProj: new Float32Array(vp.asArray()),
      viewportHeight: this.engine.getRenderHeight(),
      fovY: cam.fov,
      thresholdPx: this._thresholdPx,
      frustumCull: this._frustumCull
    };
  }

  /** Force every instance (and the full-resolution cut) to be recomputed. */
  invalidateCut(): void {
    this.fullDirty = true;
    this.markDirty();
  }

  private markDirty(): void {
    for (const inst of this.instances) inst.dirty = true;
    this.lastCamPos.set(NaN, NaN, NaN);
  }

  pendingInstances(): number {
    return this._mode === "lod" ? this.instances.reduce((s, i) => s + (i.dirty ? 1 : 0), 0) : this.fullDirty ? 1 : 0;
  }

  private writeIndices(geo: Geometry, cut: Uint32Array): void {
    const ib = geo.getIndexBuffer();
    if (ib && cut.length > 0) this.engine.updateDynamicIndexBuffer(ib, cut, 0);
  }

  private ensureFullCut(): number {
    if (!this.fullDirty || !this.runtime || !this.fullGeo) return 0;
    const t0 = performance.now();
    // Threshold 0 keeps every leaf, and every cluster whose finer children are not loaded yet.
    this.fullStats = this.runtime.select({ position: [0, 0, 0], viewProj: new Float32Array(Matrix.Identity().asArray()), viewportHeight: 1, fovY: 1, thresholdPx: 0, frustumCull: false });
    const cut = this.runtime.cut();
    this.writeIndices(this.fullGeo, cut);
    for (const inst of this.instances) inst.fullMesh.subMeshes[0].indexCount = cut.length;
    this.fullDirty = false;
    return performance.now() - t0;
  }

  private selectInstance(inst: Instance, vp: Matrix, camPos: Vector3, viewportHeight: number): { selectMs: number; uploadMs: number } {
    const runtime = this.runtime as Runtime;
    // Uniform scale cancels out of the error projection, so the object-space camera is all the runtime needs.
    Vector3.TransformCoordinatesToRef(camPos, inst.worldInv, this.camObj);
    inst.world.multiplyToRef(vp, this.vpScratch);
    inst.viewProj.set(this.vpScratch.asArray());
    const view: ViewParams = {
      position: [this.camObj.x, this.camObj.y, this.camObj.z],
      viewProj: inst.viewProj,
      viewportHeight,
      fovY: this.camera.fov,
      thresholdPx: this._thresholdPx,
      frustumCull: this._frustumCull
    };
    const t0 = performance.now();
    inst.stats = runtime.select(view);
    const cut = runtime.cut();
    const selectMs = performance.now() - t0;
    let h = cut.length;
    for (let i = 0; i < cut.length; i += 997) h = (h * 31 + cut[i]) | 0;
    let uploadMs = 0;
    if (cut.length !== inst.cutLen || h !== inst.cutHash) {
      const t1 = performance.now();
      if (cut.length > inst.capacity) {
        let cap = inst.capacity;
        while (cap < cut.length) cap *= 2;
        inst.lodGeo.setIndices(new Uint32Array(cap), runtime.manifest.totalVertices, true);
        inst.capacity = cap;
        this.resetSubMesh(inst.lodMesh, 0);
      }
      this.writeIndices(inst.lodGeo, cut);
      inst.lodMesh.subMeshes[0].indexCount = cut.length;
      inst.cutLen = cut.length;
      inst.cutHash = h;
      uploadMs = performance.now() - t1;
    }
    inst.dirty = false;
    return { selectMs, uploadMs };
  }

  private frame(): void {
    // Light follows the camera so the far side is never black.
    const dir = this.camera.target.subtract(this.camera.globalPosition).normalize();
    this.sun.direction = dir.add(new Vector3(-0.3, -0.5, 0)).normalize();

    let info: FrameInfo | null = null;
    if (!this.freezeCut && this.runtime && this.instances.length > 0) {
      const cam = this.camera;
      const vp = cam.getViewMatrix().multiply(cam.getProjectionMatrix());
      const camPos = cam.globalPosition;
      const vpArr = vp.asArray();
      let camMoved = !camPos.equals(this.lastCamPos);
      for (let i = 0; i < 16 && !camMoved; i++) if (vpArr[i] !== this.lastVp[i]) camMoved = true;
      if (camMoved) {
        for (const inst of this.instances) inst.dirty = true;
        this.lastVp.set(vpArr);
        this.lastCamPos.copyFrom(camPos);
      }

      let selectMs = 0;
      let uploadMs = 0;
      if (this._mode === "lod") {
        // Round-robin over the dirty instances within the per-frame budget.
        const n = this.instances.length;
        const h = this.engine.getRenderHeight();
        const start = this.cursor;
        for (let k = 0; k < n && selectMs < this.selectBudgetMs; k++) {
          const idx = (start + k) % n;
          const inst = this.instances[idx];
          if (!inst.dirty) continue;
          const r = this.selectInstance(inst, vp, camPos, h);
          selectMs += r.selectMs;
          uploadMs += r.uploadMs;
          this.cursor = (idx + 1) % n;
        }
      } else {
        uploadMs += this.ensureFullCut();
      }

      const stats: CutStats = { ...EMPTY_STATS };
      if (this._mode === "lod") {
        for (const inst of this.instances) {
          stats.clusters += inst.stats.clusters;
          stats.triangles += inst.stats.triangles;
          stats.culled += inst.stats.culled;
          stats.pendingRefinement += inst.stats.pendingRefinement;
          stats.coarsestLevelInCut = Math.max(stats.coarsestLevelInCut, inst.stats.coarsestLevelInCut);
        }
        stats.loadedClusters = this.instances[0].stats.loadedClusters;
        stats.loadedTriangles = this.instances[0].stats.loadedTriangles;
      } else {
        const n = this.instances.length;
        stats.clusters = this.fullStats.clusters * n;
        stats.triangles = this.fullStats.triangles * n;
        stats.pendingRefinement = this.fullStats.pendingRefinement * n;
        stats.coarsestLevelInCut = this.fullStats.coarsestLevelInCut;
        stats.loadedClusters = this.fullStats.loadedClusters;
        stats.loadedTriangles = this.fullStats.loadedTriangles;
      }
      info = { stats, selectMs, uploadMs, drawCalls: this.instances.length, mode: this._mode, pendingInstances: this.pendingInstances() };
    }
    this.scene.render();
    if (info && this.onFrame) this.onFrame(info);
    if (this.frameWaiters.length > 0) {
      const waiters = this.frameWaiters;
      this.frameWaiters = [];
      for (const w of waiters) w(info);
    }
  }

  fps(): number {
    return this.engine.getFps();
  }

  gpuName(): string {
    try {
      const info = this.engine.getGlInfo();
      return info.renderer || info.vendor || "unknown GPU";
    } catch {
      return "unknown GPU";
    }
  }

  nextFrame(): Promise<FrameInfo | null> {
    return new Promise((resolve) => this.frameWaiters.push(resolve));
  }

  /**
   * Frames per second over `ms` milliseconds in the current state. Waits until
   * every instance's cut is current first, so the number is the steady state
   * rather than the amortised selection catching up.
   */
  async measureFps(ms: number): Promise<{ fps: number; frames: number; triangles: number; refreshMs: number; frameMs: number }> {
    // A full refresh of every instance's cut first: its total cost is the
    // "select" number, since a still camera selects nothing afterwards.
    this.invalidateCut();
    let refreshMs = 0;
    for (let i = 0; i < 600; i++) {
      const f = await this.nextFrame();
      if (!f) break;
      refreshMs += f.selectMs;
      if (f.pendingInstances === 0) break;
    }
    let frames = 0;
    let tris = 0;
    const t0 = performance.now();
    let tLast = t0;
    while (tLast - t0 < ms || frames < 5) {
      const f = await this.nextFrame();
      tLast = performance.now();
      frames++;
      if (f) tris = f.stats.triangles;
    }
    const elapsed = (tLast - t0) / 1000;
    return { fps: frames / elapsed, frames, triangles: tris, refreshMs, frameMs: (elapsed * 1000) / frames };
  }
}
