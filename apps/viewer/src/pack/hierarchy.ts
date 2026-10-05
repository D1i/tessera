// In-browser port of tools/tessera-pack/src/hierarchy.rs on top of meshoptimizer's
// WebAssembly build. Same algorithm, same invariants: groups of neighbouring
// clusters are simplified to half with their border locked, re-clustered, and
// the group's error/bounds become the new clusters' `lod_*` and the members'
// `parent_*`. Grouping uses a greedy walk over the shared-vertex adjacency graph
// (meshoptimizer does not expose its partitioner to JavaScript).

import { MeshoptClusterizer, MeshoptSimplifier } from "meshoptimizer";

export const MAX_CLUSTER_VERTICES = 64;
export const MAX_CLUSTER_TRIANGLES = 128;

export interface SourceMesh {
  /** xyz triples */
  positions: Float32Array;
  /** three per triangle */
  indices: Uint32Array;
}

export interface Sphere {
  cx: number;
  cy: number;
  cz: number;
  r: number;
}

export interface Cluster {
  level: number;
  indices: Uint32Array;
  lodSphere: Sphere;
  lodError: number;
  parentSphere: Sphere;
  parentError: number;
  /** ids of the finer clusters this one was simplified from */
  children: number[];
  group: number;
}

export interface Hierarchy {
  positions: Float32Array;
  normals: Float32Array;
  clusters: Cluster[];
  levelCount: number;
  sourceTriangles: number;
}

export interface BuildProgress {
  level: number;
  clusters: number;
  trianglesIn: number;
  trianglesOut: number;
}

export async function ready(): Promise<void> {
  await Promise.all([MeshoptClusterizer.ready, MeshoptSimplifier.ready]);
}

// ------------------------------------------------------------------ helpers

/** Weld binary-identical positions and drop unused vertices. */
export function weld(src: SourceMesh): SourceMesh {
  const remap = MeshoptSimplifier.generatePositionRemap(src.positions, 3);
  const n = src.positions.length / 3;
  const newIndex = new Int32Array(n).fill(-1);
  const positions: number[] = [];
  const indices = new Uint32Array(src.indices.length);
  for (let i = 0; i < src.indices.length; i++) {
    const v = remap[src.indices[i]];
    if (newIndex[v] < 0) {
      newIndex[v] = positions.length / 3;
      positions.push(src.positions[v * 3], src.positions[v * 3 + 1], src.positions[v * 3 + 2]);
    }
    indices[i] = newIndex[v];
  }
  return { positions: new Float32Array(positions), indices };
}

export function computeNormals(positions: Float32Array, indices: Uint32Array): Float32Array {
  const n = new Float32Array(positions.length);
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3;
    const b = indices[t + 1] * 3;
    const c = indices[t + 2] * 3;
    const ux = positions[b] - positions[a];
    const uy = positions[b + 1] - positions[a + 1];
    const uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a];
    const vy = positions[c + 1] - positions[a + 1];
    const vz = positions[c + 2] - positions[a + 2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    for (const i of [a, b, c]) {
      n[i] += nx;
      n[i + 1] += ny;
      n[i + 2] += nz;
    }
  }
  for (let i = 0; i < n.length; i += 3) {
    const l = Math.hypot(n[i], n[i + 1], n[i + 2]);
    if (l > 0) {
      n[i] /= l;
      n[i + 1] /= l;
      n[i + 2] /= l;
    } else {
      n[i + 1] = 1;
    }
  }
  return n;
}

function clusterize(indices: Uint32Array, positions: Float32Array): Uint32Array[] {
  const buf = MeshoptClusterizer.buildMeshlets(indices, positions, 3, MAX_CLUSTER_VERTICES, MAX_CLUSTER_TRIANGLES, 0);
  const out: Uint32Array[] = [];
  for (let m = 0; m < buf.meshletCount; m++) {
    const ml = MeshoptClusterizer.extractMeshlet(buf, m);
    const idx = new Uint32Array(ml.triangles.length);
    for (let i = 0; i < ml.triangles.length; i++) idx[i] = ml.vertices[ml.triangles[i]];
    out.push(idx);
  }
  return out;
}

function sphereOf(indices: Uint32Array, positions: Float32Array): Sphere {
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (let i = 0; i < indices.length; i++) {
    const v = indices[i] * 3;
    cx += positions[v];
    cy += positions[v + 1];
    cz += positions[v + 2];
  }
  cx /= indices.length;
  cy /= indices.length;
  cz /= indices.length;
  let r2 = 0;
  for (let i = 0; i < indices.length; i++) {
    const v = indices[i] * 3;
    const d = (positions[v] - cx) ** 2 + (positions[v + 1] - cy) ** 2 + (positions[v + 2] - cz) ** 2;
    if (d > r2) r2 = d;
  }
  return { cx, cy, cz, r: Math.sqrt(r2) };
}

function enclosing(spheres: Sphere[]): Sphere {
  let s = { ...spheres[0] };
  for (let i = 1; i < spheres.length; i++) {
    const o = spheres[i];
    const dx = o.cx - s.cx;
    const dy = o.cy - s.cy;
    const dz = o.cz - s.cz;
    const dist = Math.hypot(dx, dy, dz);
    if (dist + o.r <= s.r) continue;
    if (dist + s.r <= o.r) {
      s = { ...o };
      continue;
    }
    const nr = (dist + s.r + o.r) * 0.5;
    const t = dist > 0 ? (nr - s.r) / dist : 0;
    s = { cx: s.cx + dx * t, cy: s.cy + dy * t, cz: s.cz + dz * t, r: nr };
  }
  return s;
}

/** Greedy grouping over the shared-vertex adjacency graph, ~groupSize clusters per group. */
function partition(clusters: Cluster[], current: number[], vertexCount: number, groupSize: number): number[][] {
  if (current.length <= groupSize) return [current.slice()];
  // vertex -> clusters (local ids within `current`)
  const owners = new Map<number, number[]>();
  current.forEach((ci, k) => {
    const idx = clusters[ci].indices;
    const seen = new Set<number>();
    for (let i = 0; i < idx.length; i++) {
      const v = idx[i];
      if (seen.has(v)) continue;
      seen.add(v);
      let list = owners.get(v);
      if (!list) owners.set(v, (list = []));
      list.push(k);
    }
  });
  void vertexCount;
  // adjacency weights: how many vertices two clusters share
  const adj: Map<number, number>[] = current.map(() => new Map());
  for (const list of owners.values()) {
    for (let a = 0; a < list.length; a++) {
      for (let b = a + 1; b < list.length; b++) {
        adj[list[a]].set(list[b], (adj[list[a]].get(list[b]) ?? 0) + 1);
        adj[list[b]].set(list[a], (adj[list[b]].get(list[a]) ?? 0) + 1);
      }
    }
  }
  const assigned = new Int32Array(current.length).fill(-1);
  const groups: number[][] = [];
  // Seed order: by centroid along a space-filling-ish key so leftovers stay local.
  const order = current.map((ci, k) => ({ k, key: clusters[ci].lodSphere.cx * 7.3 + clusters[ci].lodSphere.cy * 3.1 + clusters[ci].lodSphere.cz })).sort((a, b) => a.key - b.key).map((o) => o.k);
  for (const seed of order) {
    if (assigned[seed] >= 0) continue;
    const gid = groups.length;
    const members: number[] = [seed];
    assigned[seed] = gid;
    // frontier: candidate -> weight to the group
    const frontier = new Map<number, number>();
    const addNeighbours = (k: number) => {
      for (const [nb, w] of adj[k]) if (assigned[nb] < 0) frontier.set(nb, (frontier.get(nb) ?? 0) + w);
    };
    addNeighbours(seed);
    while (members.length < groupSize && frontier.size > 0) {
      let best = -1;
      let bestW = -1;
      for (const [nb, w] of frontier) {
        if (assigned[nb] >= 0) continue;
        if (w > bestW) {
          bestW = w;
          best = nb;
        }
      }
      if (best < 0) break;
      frontier.delete(best);
      assigned[best] = gid;
      members.push(best);
      addNeighbours(best);
    }
    groups.push(members.map((k) => current[k]));
  }
  // Merge tiny leftover groups into a neighbour when possible.
  return groups;
}

// -------------------------------------------------------------------- build

export function build(source: SourceMesh, groupSize: number, onProgress?: (p: BuildProgress) => void): Hierarchy {
  const mesh = weld(source);
  const positions = mesh.positions;
  const vertexCount = positions.length / 3;
  const clusters: Cluster[] = [];

  let current: number[] = [];
  for (const idx of clusterize(mesh.indices, positions)) {
    const s = sphereOf(idx, positions);
    clusters.push({ level: 0, indices: idx, lodSphere: s, lodError: 0, parentSphere: s, parentError: Infinity, children: [], group: 0 });
    current.push(clusters.length - 1);
  }
  onProgress?.({ level: 0, clusters: current.length, trianglesIn: mesh.indices.length / 3, trianglesOut: mesh.indices.length / 3 });

  let level = 0;
  while (current.length > 1) {
    const groups = partition(clusters, current, vertexCount, groupSize);

    // Vertices used by more than one group are locked.
    const owner = new Int32Array(vertexCount).fill(-1);
    const shared = new Uint8Array(vertexCount);
    groups.forEach((g, gi) => {
      for (const ci of g) {
        const idx = clusters[ci].indices;
        for (let i = 0; i < idx.length; i++) {
          const v = idx[i];
          if (owner[v] < 0) owner[v] = gi;
          else if (owner[v] !== gi) shared[v] = 1;
        }
      }
    });

    const next: number[] = [];
    let trisIn = 0;
    let trisOut = 0;
    groups.forEach((g, gi) => {
      for (const ci of g) clusters[ci].group = gi;
      let total = 0;
      for (const ci of g) total += clusters[ci].indices.length;
      const merged = new Uint32Array(total);
      let at = 0;
      for (const ci of g) {
        merged.set(clusters[ci].indices, at);
        at += clusters[ci].indices.length;
      }
      trisIn += merged.length / 3;

      // Compact sub-mesh.
      const localOf = new Map<number, number>();
      const globalOf: number[] = [];
      const localIdx = new Uint32Array(merged.length);
      for (let i = 0; i < merged.length; i++) {
        const v = merged[i];
        let l = localOf.get(v);
        if (l === undefined) {
          l = globalOf.length;
          localOf.set(v, l);
          globalOf.push(v);
        }
        localIdx[i] = l;
      }
      const localPos = new Float32Array(globalOf.length * 3);
      const locks = new Uint8Array(globalOf.length);
      for (let l = 0; l < globalOf.length; l++) {
        const v = globalOf[l];
        localPos[l * 3] = positions[v * 3];
        localPos[l * 3 + 1] = positions[v * 3 + 1];
        localPos[l * 3 + 2] = positions[v * 3 + 2];
        locks[l] = shared[v];
      }
      const target = Math.floor(localIdx.length / 3 / 2) * 3;
      const [simplified, err] = MeshoptSimplifier.simplifyWithAttributes(localIdx, localPos, 3, new Float32Array(0), 0, [], locks, target, 1e30, ["LockBorder", "ErrorAbsolute"]);
      const groupSphere = enclosing(g.map((ci) => clusters[ci].lodSphere));
      let childErr = 0;
      for (const ci of g) childErr = Math.max(childErr, clusters[ci].lodError);
      const groupError = Math.max(err, childErr);

      if (simplified.length === 0 || simplified.length / 3 > ((merged.length / 3) * 9) / 10) return; // root group
      trisOut += simplified.length / 3;
      for (const ci of g) {
        clusters[ci].parentSphere = groupSphere;
        clusters[ci].parentError = groupError;
      }
      const globalSimplified = new Uint32Array(simplified.length);
      for (let i = 0; i < simplified.length; i++) globalSimplified[i] = globalOf[simplified[i]];
      for (const idx of clusterize(globalSimplified, positions)) {
        clusters.push({ level: level + 1, indices: idx, lodSphere: groupSphere, lodError: groupError, parentSphere: groupSphere, parentError: Infinity, children: g.slice(), group: 0 });
        next.push(clusters.length - 1);
      }
    });
    if (next.length === 0) break;
    level++;
    onProgress?.({ level, clusters: next.length, trianglesIn: trisIn, trianglesOut: trisOut });
    current = next;
  }

  return { positions, normals: computeNormals(positions, mesh.indices), clusters, levelCount: level + 1, sourceTriangles: mesh.indices.length / 3 };
}
