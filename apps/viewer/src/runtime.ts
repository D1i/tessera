// Two interchangeable runtimes behind one interface: the Rust/WebAssembly
// build (crates/tessera-runtime) and a straight TypeScript port of the same
// algorithm, kept as the reference implementation and as the baseline the
// benchmark panel compares against.

import { decodeArchiveTable, decodeClusterBlob, decodeManifest, type ClusterInfo, type Manifest } from "./format";

export interface ViewParams {
  position: [number, number, number];
  /** Column-major view-projection matrix. */
  viewProj: Float32Array;
  viewportHeight: number;
  fovY: number;
  thresholdPx: number;
  frustumCull: boolean;
}

export interface CutStats {
  clusters: number;
  triangles: number;
  culled: number;
  loadedClusters: number;
  loadedTriangles: number;
  pendingRefinement: number;
  coarsestLevelInCut: number;
}

export interface Runtime {
  readonly kind: "wasm" | "js";
  readonly manifest: Manifest;
  /** Decode an archive; returns the pool vertex range [first, count) it filled. */
  addArchive(id: number, bytes: ArrayBuffer): [number, number];
  select(view: ViewParams): CutStats;
  /** Views over the pool. Re-read after every addArchive (the WASM memory may move). */
  positions(): Float32Array;
  normals(): Float32Array;
  colors(): Uint8Array;
  cut(): Uint32Array;
  poolVertexCount(): number;
}

export function clusterColor(id: number, out: Uint8Array, o: number): void {
  const h = ((id * 0.618034) % 1) * 6;
  const s = 0.55;
  const v = 0.95;
  const c = v * s;
  const x = c * (1 - Math.abs((h % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  switch (Math.floor(h)) {
    case 0: r = c; g = x; break;
    case 1: r = x; g = c; break;
    case 2: g = c; b = x; break;
    case 3: g = x; b = c; break;
    case 4: r = x; b = c; break;
    default: r = c; b = x;
  }
  const m = v - c;
  out[o] = ((r + m) * 255) | 0;
  out[o + 1] = ((g + m) * 255) | 0;
  out[o + 2] = ((b + m) * 255) | 0;
  out[o + 3] = 255;
}

// ------------------------------------------------------------ JS reference

export class JsRuntime implements Runtime {
  readonly kind = "js" as const;
  readonly manifest: Manifest;
  private clusters: (ClusterInfo | null)[];
  private archiveLoaded: boolean[];
  private vertexBase: Uint32Array;
  private indexFirst: Uint32Array;
  private pos: Float32Array;
  private nrm: Float32Array;
  private col: Uint8Array;
  private idx: Uint32Array;
  private indexCount = 0;
  private poolVertices = 0;
  private cutBuf: Uint32Array;
  private cutLen = 0;
  private render: Uint8Array;
  private planes = new Float32Array(24);

  constructor(manifestBytes: ArrayBuffer) {
    this.manifest = decodeManifest(manifestBytes);
    const n = this.manifest.clusterCount;
    this.clusters = new Array(n).fill(null);
    this.archiveLoaded = new Array(this.manifest.archives.length).fill(false);
    this.vertexBase = new Uint32Array(n);
    this.indexFirst = new Uint32Array(n);
    this.pos = new Float32Array(this.manifest.totalVertices * 3);
    this.nrm = new Float32Array(this.manifest.totalVertices * 3);
    this.col = new Uint8Array(this.manifest.totalVertices * 4);
    this.idx = new Uint32Array(this.manifest.totalTriangles * 3);
    this.cutBuf = new Uint32Array(this.manifest.totalTriangles * 3);
    this.render = new Uint8Array(n);
  }

  addArchive(id: number, bytes: ArrayBuffer): [number, number] {
    const info = this.manifest.archives[id];
    if (!info) throw new Error("archive id out of range");
    if (this.archiveLoaded[id]) throw new Error(`archive ${id} already loaded`);
    if (id > 0 && !this.archiveLoaded[id - 1]) throw new Error(`archive ${id} added before ${id - 1}`);
    const table = decodeArchiveTable(this.manifest.aabb, bytes);
    const u8 = new Uint8Array(bytes);
    const firstVertex = this.poolVertices;
    for (let k = 0; k < table.clusters.length; k++) {
      const c = table.clusters[k];
      const ci = info.firstCluster + k;
      const base = this.poolVertices;
      this.vertexBase[ci] = base;
      this.indexFirst[ci] = this.indexCount;
      const d = decodeClusterBlob(this.manifest.aabb, u8, table.blobsOffset + c.offset, base, this.pos, this.nrm, this.idx, this.indexCount);
      for (let i = 0; i < d.vertexCount; i++) clusterColor(ci, this.col, (base + i) * 4);
      this.poolVertices += d.vertexCount;
      this.indexCount += d.triangleCount * 3;
      this.clusters[ci] = c;
    }
    this.archiveLoaded[id] = true;
    return [firstVertex, this.poolVertices - firstVertex];
  }

  private projectError(view: ViewParams, error: number, cx: number, cy: number, cz: number, r: number, scale: number): number {
    if (!Number.isFinite(error)) return Infinity;
    const dist = Math.hypot(cx - view.position[0], cy - view.position[1], cz - view.position[2]) - r;
    if (dist <= 0) return Infinity;
    return (error * scale) / dist;
  }

  private computePlanes(m: Float32Array): void {
    const p = this.planes;
    const rows = [
      [m[0], m[4], m[8], m[12]],
      [m[1], m[5], m[9], m[13]],
      [m[2], m[6], m[10], m[14]],
      [m[3], m[7], m[11], m[15]]
    ];
    const r3 = rows[3];
    const defs: [number, number][] = [[0, 1], [0, -1], [1, 1], [1, -1], [2, 1], [2, -1]];
    for (let k = 0; k < 6; k++) {
      const [ri, sign] = defs[k];
      const rr = rows[ri];
      let a = r3[0] + sign * rr[0];
      let b = r3[1] + sign * rr[1];
      let c = r3[2] + sign * rr[2];
      let d = r3[3] + sign * rr[3];
      const l = Math.hypot(a, b, c) || 1;
      a /= l; b /= l; c /= l; d /= l;
      p[k * 4] = a; p[k * 4 + 1] = b; p[k * 4 + 2] = c; p[k * 4 + 3] = d;
    }
  }

  private inFrustum(cx: number, cy: number, cz: number, r: number): boolean {
    const p = this.planes;
    for (let k = 0; k < 6; k++) {
      if (p[k * 4] * cx + p[k * 4 + 1] * cy + p[k * 4 + 2] * cz + p[k * 4 + 3] < -r) return false;
    }
    return true;
  }

  select(view: ViewParams): CutStats {
    const scale = view.viewportHeight / (2 * Math.tan(view.fovY * 0.5));
    if (view.frustumCull) this.computePlanes(view.viewProj);
    const stats: CutStats = { clusters: 0, triangles: 0, culled: 0, loadedClusters: 0, loadedTriangles: 0, pendingRefinement: 0, coarsestLevelInCut: 0 };
    const n = this.clusters.length;
    const render = this.render;
    for (let ci = 0; ci < n; ci++) {
      render[ci] = 0;
      const c = this.clusters[ci];
      if (!c) continue;
      stats.loadedClusters++;
      stats.loadedTriangles += c.triangleCount;
      const parentPx = this.projectError(view, c.parentError, c.parentCenter[0], c.parentCenter[1], c.parentCenter[2], c.parentRadius, scale);
      if (parentPx <= view.thresholdPx) continue;
      // A leaf has nothing finer, so it is drawn whenever its parent is not.
      if (c.childCount !== 0) {
        const ownPx = this.projectError(view, c.lodError, c.lodCenter[0], c.lodCenter[1], c.lodCenter[2], c.lodRadius, scale);
        if (ownPx > view.thresholdPx) {
          if (this.clusters[c.childFirst] !== null) continue;
          stats.pendingRefinement++;
        }
      }
      if (view.frustumCull && !this.inFrustum(c.lodCenter[0], c.lodCenter[1], c.lodCenter[2], c.lodRadius)) {
        stats.culled++;
        continue;
      }
      render[ci] = 1;
      stats.clusters++;
      stats.triangles += c.triangleCount;
      if (c.level > stats.coarsestLevelInCut) stats.coarsestLevelInCut = c.level;
    }
    let at = 0;
    for (let ci = 0; ci < n; ci++) {
      if (!render[ci]) continue;
      const first = this.indexFirst[ci];
      const len = (this.clusters[ci] as ClusterInfo).triangleCount * 3;
      this.cutBuf.set(this.idx.subarray(first, first + len), at);
      at += len;
    }
    this.cutLen = at;
    return stats;
  }

  positions(): Float32Array { return this.pos; }
  normals(): Float32Array { return this.nrm; }
  colors(): Uint8Array { return this.col; }
  cut(): Uint32Array { return this.cutBuf.subarray(0, this.cutLen); }
  poolVertexCount(): number { return this.poolVertices; }
}

// -------------------------------------------------------------- WASM adapter

interface WasmModule {
  default: (input?: unknown) => Promise<{ memory: WebAssembly.Memory }>;
  TesseraRuntime: new (manifest: Uint8Array) => WasmHandle;
}

interface WasmHandle {
  add_archive(id: number, bytes: Uint8Array): Uint32Array;
  select(x: number, y: number, z: number, vp: Float32Array, h: number, fov: number, t: number, cull: boolean): Uint32Array;
  positions_ptr(): number;
  normals_ptr(): number;
  colors_ptr(): number;
  cut_ptr(): number;
  cut_len(): number;
  pool_vertex_count(): number;
  total_vertices(): number;
}

export class WasmRuntime implements Runtime {
  readonly kind = "wasm" as const;
  readonly manifest: Manifest;
  private constructor(private memory: WebAssembly.Memory, private handle: WasmHandle, manifestBytes: ArrayBuffer) {
    this.manifest = decodeManifest(manifestBytes);
  }

  /**
   * Loads the wasm-pack output from `<base>/wasm/` (copied there by the build
   * script). Resolves to null when the package has not been built, so the viewer
   * can fall back to the TypeScript runtime.
   */
  static async load(manifestBytes: ArrayBuffer): Promise<WasmRuntime | null> {
    let mod: WasmModule;
    try {
      const url = new URL(`${import.meta.env.BASE_URL}wasm/tessera_runtime.js`, location.href).href;
      mod = (await import(/* @vite-ignore */ url)) as WasmModule;
    } catch {
      return null;
    }
    const exports = await mod.default();
    const handle = new mod.TesseraRuntime(new Uint8Array(manifestBytes));
    return new WasmRuntime(exports.memory, handle, manifestBytes);
  }

  addArchive(id: number, bytes: ArrayBuffer): [number, number] {
    const r = this.handle.add_archive(id, new Uint8Array(bytes));
    return [r[0], r[1]];
  }

  select(view: ViewParams): CutStats {
    const s = this.handle.select(view.position[0], view.position[1], view.position[2], view.viewProj, view.viewportHeight, view.fovY, view.thresholdPx, view.frustumCull);
    return { clusters: s[0], triangles: s[1], culled: s[2], loadedClusters: s[3], loadedTriangles: s[4], pendingRefinement: s[5], coarsestLevelInCut: s[6] };
  }

  positions(): Float32Array { return new Float32Array(this.memory.buffer, this.handle.positions_ptr(), this.handle.pool_vertex_count() * 3); }
  normals(): Float32Array { return new Float32Array(this.memory.buffer, this.handle.normals_ptr(), this.handle.pool_vertex_count() * 3); }
  colors(): Uint8Array { return new Uint8Array(this.memory.buffer, this.handle.colors_ptr(), this.handle.pool_vertex_count() * 4); }
  cut(): Uint32Array { return new Uint32Array(this.memory.buffer, this.handle.cut_ptr(), this.handle.cut_len()); }
  poolVertexCount(): number { return this.handle.pool_vertex_count(); }
}
