//! Cluster LOD hierarchy, built the way virtualized-geometry renderers do it:
//!
//! 1. Split the mesh into clusters (meshlets of <=128 triangles, <=64 vertices).
//! 2. Partition clusters into groups of ~8 that share edges.
//! 3. Simplify every group to half its triangles with the group border locked,
//!    so neighbouring groups never open cracks against each other.
//! 4. Re-cluster the simplified group: those clusters form the next level and
//!    inherit the group's error and bounds; the group's members get the same
//!    values as their `parent_*`.
//! 5. Repeat until one cluster is left or simplification stops making progress.
//!
//! Errors are monotonic up the hierarchy (max of simplification error and the
//! children's errors) and parent bounds enclose child bounds, so the per-frame
//! cut decision made independently per cluster is consistent.

use crate::mesh::Mesh;
use meshopt::{SimplifyOptions, VertexDataAdapter};
use std::collections::HashMap;
use tessera_format::{Sphere, MAX_CLUSTER_TRIANGLES, MAX_CLUSTER_VERTICES};

#[derive(Clone, Debug)]
pub struct Cluster {
    pub level: u32,
    /// Global indices into the welded mesh, three per triangle.
    pub indices: Vec<u32>,
    pub lod_sphere: Sphere,
    pub lod_error: f32,
    pub parent_sphere: Sphere,
    pub parent_error: f32,
    /// Ids of the finer clusters this cluster was simplified from.
    pub children: Vec<usize>,
    /// Group id at this cluster's level (clusters simplified together).
    pub group: usize,
}

pub struct Hierarchy {
    pub mesh: Mesh,
    pub clusters: Vec<Cluster>,
    pub level_count: u32,
}

pub struct BuildOptions {
    pub group_size: usize,
    pub verbose: bool,
}

impl Default for BuildOptions {
    fn default() -> Self {
        BuildOptions {
            group_size: 8,
            verbose: true,
        }
    }
}

fn adapter(positions: &[[f32; 3]]) -> VertexDataAdapter<'_> {
    let bytes = unsafe {
        std::slice::from_raw_parts(positions.as_ptr().cast::<u8>(), positions.len() * 12)
    };
    VertexDataAdapter::new(bytes, 12, 0).expect("12-byte positions")
}

/// Weld binary-identical vertices (grid seams, poles) so simplification sees a closed surface.
pub fn weld(mesh: &Mesh) -> Mesh {
    let (count, remap) = meshopt::generate_vertex_remap(&mesh.positions, Some(&mesh.indices));
    let positions = meshopt::remap_vertex_buffer(&mesh.positions, count, &remap);
    let indices = meshopt::remap_index_buffer(Some(&mesh.indices), count, &remap);
    let mut m = Mesh {
        positions,
        normals: Vec::new(),
        indices,
    };
    m.compute_normals();
    m
}

/// Split an index list into meshlets and return each meshlet's global index list.
fn clusterize(indices: &[u32], positions: &[[f32; 3]]) -> Vec<Vec<u32>> {
    let va = adapter(positions);
    let meshlets = meshopt::build_meshlets(
        indices,
        &va,
        MAX_CLUSTER_VERTICES,
        MAX_CLUSTER_TRIANGLES,
        0.0,
    );
    meshlets
        .iter()
        .map(|m| {
            m.triangles
                .iter()
                .map(|&li| m.vertices[li as usize])
                .collect()
        })
        .collect()
}

fn sphere_of(indices: &[u32], positions: &[[f32; 3]]) -> Sphere {
    let pts: Vec<[f32; 3]> = indices.iter().map(|&i| positions[i as usize]).collect();
    Sphere::from_points(pts.iter())
}

pub fn build(source: &Mesh, opts: &BuildOptions) -> Hierarchy {
    let mesh = weld(source);
    let positions = &mesh.positions;
    let mut clusters: Vec<Cluster> = Vec::new();

    // Level 0.
    let mut current: Vec<usize> = Vec::new();
    for idx in clusterize(&mesh.indices, positions) {
        let s = sphere_of(&idx, positions);
        clusters.push(Cluster {
            level: 0,
            indices: idx,
            lod_sphere: s,
            lod_error: 0.0,
            parent_sphere: s,
            parent_error: f32::INFINITY,
            children: Vec::new(),
            group: 0,
        });
        current.push(clusters.len() - 1);
    }
    if opts.verbose {
        eprintln!(
            "level 0: {} triangles -> {} clusters",
            mesh.triangle_count(),
            current.len()
        );
    }

    let mut level = 0u32;
    while current.len() > 1 {
        // Partition the current level into groups of neighbouring clusters.
        let groups = partition(&clusters, &current, positions, opts.group_size);

        // A vertex shared by two groups must not move during simplification.
        let mut owner: HashMap<u32, u32> = HashMap::new();
        let mut shared: HashMap<u32, bool> = HashMap::new();
        for (gi, g) in groups.iter().enumerate() {
            for &ci in g {
                for &v in &clusters[ci].indices {
                    match owner.get(&v) {
                        None => {
                            owner.insert(v, gi as u32);
                        }
                        Some(&o) if o != gi as u32 => {
                            shared.insert(v, true);
                        }
                        _ => {}
                    }
                }
            }
        }

        let mut next: Vec<usize> = Vec::new();
        let mut tris_in = 0usize;
        let mut tris_out = 0usize;
        for (gi, g) in groups.iter().enumerate() {
            for &ci in g {
                clusters[ci].group = gi;
            }
            let merged: Vec<u32> = g
                .iter()
                .flat_map(|&ci| clusters[ci].indices.iter().copied())
                .collect();
            tris_in += merged.len() / 3;

            // Compact sub-mesh for this group.
            let mut local_of: HashMap<u32, u32> = HashMap::new();
            let mut local_pos: Vec<[f32; 3]> = Vec::new();
            let mut global_of: Vec<u32> = Vec::new();
            let local_idx: Vec<u32> = merged
                .iter()
                .map(|&v| {
                    *local_of.entry(v).or_insert_with(|| {
                        local_pos.push(positions[v as usize]);
                        global_of.push(v);
                        (local_pos.len() - 1) as u32
                    })
                })
                .collect();
            let locks: Vec<bool> = global_of.iter().map(|v| shared.contains_key(v)).collect();

            let va = adapter(&local_pos);
            let target = (local_idx.len() / 3 / 2) * 3;
            let mut err = 0f32;
            let simplified = meshopt::simplify_with_locks(
                &local_idx,
                &va,
                &locks,
                target,
                f32::MAX,
                SimplifyOptions::LockBorder | SimplifyOptions::ErrorAbsolute,
                Some(&mut err),
            );
            let group_sphere = Sphere::enclosing(
                &g.iter()
                    .map(|&ci| clusters[ci].lod_sphere)
                    .collect::<Vec<_>>(),
            );
            let child_err = g
                .iter()
                .map(|&ci| clusters[ci].lod_error)
                .fold(0f32, f32::max);
            let group_error = err.max(child_err);

            // Not enough reduction: this group is a root, its clusters stay as the
            // coarsest representation of their region.
            if simplified.len() / 3 > merged.len() / 3 * 9 / 10 || simplified.is_empty() {
                continue;
            }
            tris_out += simplified.len() / 3;
            for &ci in g {
                clusters[ci].parent_sphere = group_sphere;
                clusters[ci].parent_error = group_error;
            }
            let global_simplified: Vec<u32> = simplified
                .iter()
                .map(|&li| global_of[li as usize])
                .collect();
            for idx in clusterize(&global_simplified, positions) {
                clusters.push(Cluster {
                    level: level + 1,
                    indices: idx,
                    lod_sphere: group_sphere,
                    lod_error: group_error,
                    parent_sphere: group_sphere,
                    parent_error: f32::INFINITY,
                    children: g.clone(),
                    group: 0,
                });
                next.push(clusters.len() - 1);
            }
        }
        if next.is_empty() {
            break;
        }
        level += 1;
        if opts.verbose {
            eprintln!(
                "level {level}: {} groups, {tris_in} -> {tris_out} triangles, {} clusters",
                groups.len(),
                next.len()
            );
        }
        current = next;
    }

    Hierarchy {
        mesh,
        clusters,
        level_count: level + 1,
    }
}

fn partition(
    clusters: &[Cluster],
    current: &[usize],
    positions: &[[f32; 3]],
    group_size: usize,
) -> Vec<Vec<usize>> {
    if current.len() <= group_size {
        return vec![current.to_vec()];
    }
    let cluster_indices: Vec<u32> = current
        .iter()
        .flat_map(|&ci| clusters[ci].indices.iter().copied())
        .collect();
    let counts: Vec<u32> = current
        .iter()
        .map(|&ci| clusters[ci].indices.len() as u32)
        .collect();
    let mut dest = vec![0u32; current.len()];
    let va = adapter(positions);
    let n = meshopt::partition_clusters_with_positions(
        &mut dest,
        &cluster_indices,
        &counts,
        &va,
        group_size,
    );
    let mut groups: Vec<Vec<usize>> = vec![Vec::new(); n];
    for (k, &ci) in current.iter().enumerate() {
        groups[dest[k] as usize].push(ci);
    }
    groups.retain(|g| !g.is_empty());
    groups
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mesh::asteroid;

    #[test]
    fn builds_monotonic_hierarchy() {
        let m = asteroid(60, 120, 3);
        let h = build(
            &m,
            &BuildOptions {
                group_size: 8,
                verbose: false,
            },
        );
        assert!(h.level_count >= 3, "levels {}", h.level_count);
        let l0 = h.clusters.iter().filter(|c| c.level == 0).count();
        let top = h
            .clusters
            .iter()
            .filter(|c| c.level == h.level_count - 1)
            .count();
        assert!(top < l0);
        for c in &h.clusters {
            assert!(c.parent_error >= c.lod_error);
            assert!(c.indices.len() / 3 <= MAX_CLUSTER_TRIANGLES);
            let mut uniq: Vec<u32> = c.indices.clone();
            uniq.sort_unstable();
            uniq.dedup();
            assert!(uniq.len() <= MAX_CLUSTER_VERTICES);
            for &ch in &c.children {
                assert!(h.clusters[ch].level + 1 == c.level);
                assert!(h.clusters[ch].parent_error == c.lod_error);
            }
        }
    }
}
