// In-browser port of tools/tessera-pack/src/pack.rs: orders the hierarchy coarsest
// first (children contiguous), quantizes every cluster into its blob and cuts
// the sequence into archives with the same size schedule as the Rust packer.
// Output is byte-identical in layout to what tessera_pack writes, so the same runtime
// (WebAssembly or TypeScript) consumes it.

import type { Cluster, Hierarchy } from "./hierarchy";

export const DEFAULT_SCHEDULE = [0.02, 0.08, 0.15, 0.2, 0.25, 0.3];
const RECORD_BYTES = 40;

export interface PackedModel {
  manifest: ArrayBuffer;
  archives: ArrayBuffer[];
  clusterCount: number;
  levelCount: number;
  sourceTriangles: number;
  totalBytes: number;
}

function encodeNormal(nx: number, ny: number, nz: number): [number, number] {
  const l = Math.abs(nx) + Math.abs(ny) + Math.abs(nz);
  let x = l > 0 ? nx / l : 0;
  let y = l > 0 ? ny / l : 0;
  if (nz < 0) {
    const ox = (1 - Math.abs(y)) * (x >= 0 ? 1 : -1);
    const oy = (1 - Math.abs(x)) * (y >= 0 ? 1 : -1);
    x = ox;
    y = oy;
  }
  return [Math.min(255, ((x * 0.5 + 0.5) * 255 + 0.5) | 0), Math.min(255, ((y * 0.5 + 0.5) * 255 + 0.5) | 0)];
}

export function pack(h: Hierarchy, schedule = DEFAULT_SCHEDULE): PackedModel {
  const { positions, normals, clusters } = h;
  // AABB
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      if (positions[i + k] < min[k]) min[k] = positions[i + k];
      if (positions[i + k] > max[k]) max[k] = positions[i + k];
    }
  }
  const ext = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  const diag = Math.hypot(ext[0], ext[1], ext[2]) || 1;
  const q16 = (v: number, k: number) => {
    const t = ext[k] > 0 ? (v - min[k]) / ext[k] : 0;
    return Math.max(0, Math.min(65535, (Math.max(0, Math.min(1, t)) * 65535 + 0.5) | 0));
  };
  const qr = (r: number) => Math.min(65535, Math.ceil(Math.max(0, Math.min(1, r / diag)) * 65535));

  // Order: level descending, then group, then id.
  const order = clusters.map((_, i) => i).sort((a, b) => clusters[b].level - clusters[a].level || clusters[a].group - clusters[b].group || a - b);
  const newIndex = new Uint32Array(clusters.length);
  order.forEach((oi, ni) => (newIndex[oi] = ni));

  // Blobs + records.
  const blobs: Uint8Array[] = [];
  const records: Uint8Array[] = [];
  let totalVertices = 0;
  let totalTriangles = 0;
  for (const oi of order) {
    const c: Cluster = clusters[oi];
    const localOf = new Map<number, number>();
    const verts: number[] = [];
    const local = new Uint8Array(c.indices.length);
    for (let i = 0; i < c.indices.length; i++) {
      const v = c.indices[i];
      let l = localOf.get(v);
      if (l === undefined) {
        l = verts.length;
        localOf.set(v, l);
        verts.push(v);
      }
      local[i] = l;
    }
    const blob = new Uint8Array(2 + verts.length * 8 + local.length);
    blob[0] = verts.length;
    blob[1] = local.length / 3;
    let p = 2;
    for (const v of verts) {
      const qx = q16(positions[v * 3], 0);
      const qy = q16(positions[v * 3 + 1], 1);
      const qz = q16(positions[v * 3 + 2], 2);
      blob[p] = qx & 255; blob[p + 1] = qx >> 8;
      blob[p + 2] = qy & 255; blob[p + 3] = qy >> 8;
      blob[p + 4] = qz & 255; blob[p + 5] = qz >> 8;
      const [ex, ey] = encodeNormal(normals[v * 3], normals[v * 3 + 1], normals[v * 3 + 2]);
      blob[p + 6] = ex; blob[p + 7] = ey;
      p += 8;
    }
    blob.set(local, p);
    blobs.push(blob);
    totalVertices += verts.length;
    totalTriangles += local.length / 3;

    let childFirst = 0;
    let childCount = 0;
    if (c.children.length) {
      let lo = Infinity;
      let hi = -Infinity;
      for (const ch of c.children) {
        lo = Math.min(lo, newIndex[ch]);
        hi = Math.max(hi, newIndex[ch]);
      }
      childFirst = lo;
      childCount = hi - lo + 1;
    }
    const rec = new Uint8Array(RECORD_BYTES);
    const dv = new DataView(rec.buffer);
    rec[1] = c.level;
    rec[2] = verts.length;
    rec[3] = local.length / 3;
    dv.setUint16(8, blob.length, true);
    dv.setUint16(10, childCount, true);
    dv.setUint32(12, childFirst, true);
    dv.setUint16(16, q16(c.lodSphere.cx, 0), true);
    dv.setUint16(18, q16(c.lodSphere.cy, 1), true);
    dv.setUint16(20, q16(c.lodSphere.cz, 2), true);
    dv.setUint16(22, qr(c.lodSphere.r), true);
    dv.setUint16(24, q16(c.parentSphere.cx, 0), true);
    dv.setUint16(26, q16(c.parentSphere.cy, 1), true);
    dv.setUint16(28, q16(c.parentSphere.cz, 2), true);
    dv.setUint16(30, qr(c.parentSphere.r), true);
    dv.setFloat32(32, c.lodError, true);
    dv.setFloat32(36, c.parentError, true);
    records.push(rec);
  }

  // Cut into archives at group boundaries.
  const rawTotal = blobs.reduce((s, b) => s + b.length, 0);
  const norm = schedule.reduce((a, b) => a + b, 0);
  const cuts: number[] = [];
  let acc = 0;
  for (const s of schedule) {
    acc += s / norm;
    cuts.push(Math.floor(acc * rawTotal));
  }
  const key = (i: number) => clusters[order[i]].level * 1e7 + clusters[order[i]].group;
  const archives: ArrayBuffer[] = [];
  const archiveTable: { byteLen: number; firstCluster: number; clusterCount: number }[] = [];
  let first = 0;
  let consumed = 0;
  let target = 0;
  let offset = 0;
  const offsets = new Uint32Array(blobs.length);
  for (let i = 0; i < blobs.length; i++) {
    offsets[i] = offset;
    offset += blobs[i].length;
    consumed += blobs[i].length;
    const last = i + 1 === blobs.length;
    const boundary = last || key(i) !== key(i + 1);
    const over = target + 1 < schedule.length && consumed >= cuts[target];
    if (boundary && (over || last)) {
      const count = i + 1 - first;
      let blobBytes = 0;
      for (let k = first; k <= i; k++) blobBytes += blobs[k].length;
      const out = new Uint8Array(8 + count * RECORD_BYTES + blobBytes);
      out.set([0x54, 0x53, 0x41, 0x31]); // TSA1
      new DataView(out.buffer).setUint32(4, count, true);
      let at = 8;
      const base = offsets[first];
      for (let k = first; k <= i; k++) {
        const rec = records[k];
        rec[0] = archives.length;
        new DataView(rec.buffer).setUint32(4, offsets[k] - base, true);
        out.set(rec, at);
        at += RECORD_BYTES;
      }
      for (let k = first; k <= i; k++) {
        out.set(blobs[k], at);
        at += blobs[k].length;
      }
      archiveTable.push({ byteLen: out.length, firstCluster: first, clusterCount: count });
      archives.push(out.buffer);
      first = i + 1;
      offset = 0;
      target++;
    }
  }

  // Manifest.
  const man = new Uint8Array(56 + archiveTable.length * 12);
  const mv = new DataView(man.buffer);
  man.set([0x54, 0x53, 0x4d, 0x31]); // TSM1
  mv.setUint32(4, 1, true);
  mv.setUint32(8, clusters.length, true);
  mv.setUint32(12, archiveTable.length, true);
  mv.setUint32(16, h.levelCount, true);
  for (let k = 0; k < 3; k++) mv.setFloat32(20 + k * 4, min[k], true);
  for (let k = 0; k < 3; k++) mv.setFloat32(32 + k * 4, max[k], true);
  mv.setUint32(44, totalVertices, true);
  mv.setUint32(48, totalTriangles, true);
  mv.setUint32(52, h.sourceTriangles, true);
  archiveTable.forEach((a, i) => {
    mv.setUint32(56 + i * 12, a.byteLen, true);
    mv.setUint32(60 + i * 12, a.firstCluster, true);
    mv.setUint32(64 + i * 12, a.clusterCount, true);
  });
  return {
    manifest: man.buffer,
    archives,
    clusterCount: clusters.length,
    levelCount: h.levelCount,
    sourceTriangles: h.sourceTriangles,
    totalBytes: archives.reduce((s, a) => s + a.byteLength, 0)
  };
}
