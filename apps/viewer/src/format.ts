// TypeScript mirror of crates/tessera-format: manifest, archive table and cluster blobs.
// Used by the JavaScript reference runtime and by the loader; the WebAssembly
// runtime has its own copy of this logic in Rust.

export interface Aabb {
  min: [number, number, number];
  max: [number, number, number];
}

export interface ArchiveInfo {
  byteLen: number;
  firstCluster: number;
  clusterCount: number;
}

export interface Manifest {
  aabb: Aabb;
  clusterCount: number;
  levelCount: number;
  totalVertices: number;
  totalTriangles: number;
  sourceTriangles: number;
  archives: ArchiveInfo[];
}

/** One cluster record (40 bytes in the archive). Spheres are world-space. */
export interface ClusterInfo {
  archive: number;
  level: number;
  vertexCount: number;
  triangleCount: number;
  offset: number;
  byteLen: number;
  childCount: number;
  childFirst: number;
  lodCenter: [number, number, number];
  lodRadius: number;
  lodError: number;
  parentCenter: [number, number, number];
  parentRadius: number;
  parentError: number;
}

export const CLUSTER_RECORD_BYTES = 40;

function magic(view: DataView, expected: string): void {
  const got = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (got !== expected) throw new Error(`expected ${expected}, got ${got}`);
}

export function decodeManifest(buf: ArrayBuffer): Manifest {
  const v = new DataView(buf);
  magic(v, "TSM1");
  if (v.getUint32(4, true) !== 1) throw new Error("unsupported manifest version");
  const clusterCount = v.getUint32(8, true);
  const archiveCount = v.getUint32(12, true);
  const levelCount = v.getUint32(16, true);
  const aabb: Aabb = {
    min: [v.getFloat32(20, true), v.getFloat32(24, true), v.getFloat32(28, true)],
    max: [v.getFloat32(32, true), v.getFloat32(36, true), v.getFloat32(40, true)]
  };
  const totalVertices = v.getUint32(44, true);
  const totalTriangles = v.getUint32(48, true);
  const sourceTriangles = v.getUint32(52, true);
  const archives: ArchiveInfo[] = [];
  let at = 56;
  for (let i = 0; i < archiveCount; i++) {
    archives.push({ byteLen: v.getUint32(at, true), firstCluster: v.getUint32(at + 4, true), clusterCount: v.getUint32(at + 8, true) });
    at += 12;
  }
  return { aabb, clusterCount, levelCount, totalVertices, totalTriangles, sourceTriangles, archives };
}

export function aabbExtent(b: Aabb): [number, number, number] {
  return [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
}

export function aabbDiagonal(b: Aabb): number {
  const e = aabbExtent(b);
  return Math.hypot(e[0], e[1], e[2]);
}

function sphereFromQ(aabb: Aabb, v: DataView, at: number): { c: [number, number, number]; r: number } {
  const e = aabbExtent(aabb);
  const c: [number, number, number] = [
    aabb.min[0] + (v.getUint16(at, true) / 65535) * e[0],
    aabb.min[1] + (v.getUint16(at + 2, true) / 65535) * e[1],
    aabb.min[2] + (v.getUint16(at + 4, true) / 65535) * e[2]
  ];
  return { c, r: (v.getUint16(at + 6, true) / 65535) * aabbDiagonal(aabb) };
}

export interface ArchiveTable {
  clusters: ClusterInfo[];
  blobsOffset: number;
}

export function decodeArchiveTable(aabb: Aabb, buf: ArrayBuffer): ArchiveTable {
  const v = new DataView(buf);
  magic(v, "TSA1");
  const count = v.getUint32(4, true);
  const clusters: ClusterInfo[] = new Array(count);
  let at = 8;
  for (let i = 0; i < count; i++) {
    const lod = sphereFromQ(aabb, v, at + 16);
    const parent = sphereFromQ(aabb, v, at + 24);
    clusters[i] = {
      archive: v.getUint8(at),
      level: v.getUint8(at + 1),
      vertexCount: v.getUint8(at + 2),
      triangleCount: v.getUint8(at + 3),
      offset: v.getUint32(at + 4, true),
      byteLen: v.getUint16(at + 8, true),
      childCount: v.getUint16(at + 10, true),
      childFirst: v.getUint32(at + 12, true),
      lodCenter: lod.c,
      lodRadius: lod.r,
      lodError: v.getFloat32(at + 32, true),
      parentCenter: parent.c,
      parentRadius: parent.r,
      parentError: v.getFloat32(at + 36, true)
    };
    at += CLUSTER_RECORD_BYTES;
  }
  return { clusters, blobsOffset: at };
}

/** Octahedral normal decode, same as the Rust side. */
export function decodeNormal(ex: number, ey: number, out: Float32Array, o: number): void {
  let x = (ex / 255) * 2 - 1;
  let y = (ey / 255) * 2 - 1;
  const z = 1 - Math.abs(x) - Math.abs(y);
  if (z < 0) {
    const nx = (1 - Math.abs(y)) * (x >= 0 ? 1 : -1);
    const ny = (1 - Math.abs(x)) * (y >= 0 ? 1 : -1);
    x = nx;
    y = ny;
  }
  const l = Math.hypot(x, y, z) || 1;
  out[o] = x / l;
  out[o + 1] = y / l;
  out[o + 2] = z / l;
}

/**
 * Decode one cluster blob into the pool at `baseVertex`. Writes `vertexCount`
 * vertices and `triangleCount * 3` global indices starting at `indexAt`.
 */
export function decodeClusterBlob(
  aabb: Aabb,
  bytes: Uint8Array,
  at: number,
  baseVertex: number,
  positions: Float32Array,
  normals: Float32Array,
  indices: Uint32Array,
  indexAt: number
): { vertexCount: number; triangleCount: number } {
  const vc = bytes[at];
  const tc = bytes[at + 1];
  const e = aabbExtent(aabb);
  let p = at + 2;
  let o = baseVertex * 3;
  for (let i = 0; i < vc; i++) {
    const qx = bytes[p] | (bytes[p + 1] << 8);
    const qy = bytes[p + 2] | (bytes[p + 3] << 8);
    const qz = bytes[p + 4] | (bytes[p + 5] << 8);
    positions[o] = aabb.min[0] + (qx / 65535) * e[0];
    positions[o + 1] = aabb.min[1] + (qy / 65535) * e[1];
    positions[o + 2] = aabb.min[2] + (qz / 65535) * e[2];
    decodeNormal(bytes[p + 6], bytes[p + 7], normals, o);
    p += 8;
    o += 3;
  }
  const n = tc * 3;
  for (let i = 0; i < n; i++) indices[indexAt + i] = baseVertex + bytes[p + i];
  return { vertexCount: vc, triangleCount: tc };
}
