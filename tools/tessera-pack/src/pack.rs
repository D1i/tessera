//! Turns a [`Hierarchy`] into a manifest plus N archives.
//!
//! Clusters are ordered coarsest level first and, inside a level, by group, so
//! every cluster's children form one contiguous range. The ordered sequence is
//! cut into archives at group boundaries with a geometric size schedule: the
//! first archive is a small proxy that gives the first frame, the last ones
//! carry the bulk of level 0.

use crate::hierarchy::Hierarchy;
use std::collections::HashMap;
use tessera_format::{
    encode_archive, encode_cluster, Aabb, ArchiveInfo, ClusterBlob, ClusterInfo, Manifest,
};

pub struct Packed {
    pub manifest: Manifest,
    /// Full cluster table in archive order (also embedded per archive).
    pub clusters: Vec<ClusterInfo>,
    pub archives: Vec<Vec<u8>>,
    /// Bytes of cluster blobs before archive headers.
    pub raw_bytes: usize,
}

/// Fraction of the raw byte total each archive aims for (normalized at runtime).
pub const DEFAULT_SCHEDULE: [f32; 6] = [0.02, 0.08, 0.15, 0.2, 0.25, 0.3];

pub fn pack(h: &Hierarchy, schedule: &[f32]) -> Packed {
    let positions = &h.mesh.positions;
    let normals = &h.mesh.normals;
    let aabb = Aabb::from_points(positions.iter());

    // Order: level descending, then group id (stable), so children stay contiguous.
    let mut order: Vec<usize> = (0..h.clusters.len()).collect();
    order.sort_by_key(|&i| {
        (
            std::cmp::Reverse(h.clusters[i].level),
            h.clusters[i].group,
            i,
        )
    });
    let mut new_index = vec![0u32; h.clusters.len()];
    for (ni, &oi) in order.iter().enumerate() {
        new_index[oi] = ni as u32;
    }

    // Encode every cluster blob in the new order.
    let mut blobs: Vec<Vec<u8>> = Vec::with_capacity(order.len());
    let mut infos: Vec<ClusterInfo> = Vec::with_capacity(order.len());
    let mut total_vertices = 0u32;
    let mut total_triangles = 0u32;
    for &oi in &order {
        let c = &h.clusters[oi];
        let mut local_of: HashMap<u32, u8> = HashMap::new();
        let mut pos: Vec<[f32; 3]> = Vec::new();
        let mut nrm: Vec<[f32; 3]> = Vec::new();
        let local: Vec<u8> = c
            .indices
            .iter()
            .map(|&v| {
                *local_of.entry(v).or_insert_with(|| {
                    pos.push(positions[v as usize]);
                    nrm.push(normals[v as usize]);
                    (pos.len() - 1) as u8
                })
            })
            .collect();
        let mut blob = Vec::with_capacity(2 + pos.len() * 8 + local.len());
        encode_cluster(
            &mut blob,
            &aabb,
            &ClusterBlob {
                positions: &pos,
                normals: &nrm,
                indices: &local,
            },
        );
        total_vertices += pos.len() as u32;
        total_triangles += (local.len() / 3) as u32;

        let (child_first, child_count) = if c.children.is_empty() {
            (0, 0)
        } else {
            let first = c.children.iter().map(|&ch| new_index[ch]).min().unwrap();
            let last = c.children.iter().map(|&ch| new_index[ch]).max().unwrap();
            debug_assert_eq!(
                (last - first + 1) as usize,
                c.children.len(),
                "children must be contiguous"
            );
            (first, (last - first + 1) as u16)
        };
        infos.push(ClusterInfo {
            archive: 0,
            level: c.level as u8,
            vertex_count: pos.len() as u8,
            triangle_count: (local.len() / 3) as u8,
            offset: 0,
            byte_len: blob.len() as u16,
            child_count,
            child_first,
            lod_sphere: c.lod_sphere,
            lod_error: c.lod_error,
            parent_sphere: c.parent_sphere,
            parent_error: c.parent_error,
        });
        blobs.push(blob);
    }

    // Cut into archives at group boundaries following the size schedule.
    let raw_total: usize = blobs.iter().map(|b| b.len()).sum();
    let norm: f32 = schedule.iter().sum();
    let mut cut_targets: Vec<usize> = Vec::new();
    let mut acc = 0f32;
    for s in schedule {
        acc += s / norm;
        cut_targets.push((acc * raw_total as f32) as usize);
    }
    let group_key = |i: usize| -> (u32, usize) {
        let c = &h.clusters[order[i]];
        (c.level, c.group)
    };
    let mut archives: Vec<Vec<u8>> = Vec::new();
    let mut archive_infos: Vec<ArchiveInfo> = Vec::new();
    let mut current_raw: Vec<u8> = Vec::new();
    let mut first_cluster = 0usize;
    let mut consumed = 0usize;
    let mut target_i = 0usize;
    for i in 0..blobs.len() {
        let archive_id = archives.len();
        infos[i].archive = archive_id as u8;
        infos[i].offset = current_raw.len() as u32;
        current_raw.extend_from_slice(&blobs[i]);
        consumed += blobs[i].len();
        let last = i + 1 == blobs.len();
        let boundary = last || group_key(i) != group_key(i + 1);
        let over = target_i + 1 < schedule.len() && consumed >= cut_targets[target_i];
        if boundary && (over || last) {
            let bytes = encode_archive(&aabb, &infos[first_cluster..=i], &current_raw);
            archive_infos.push(ArchiveInfo {
                byte_len: bytes.len() as u32,
                first_cluster: first_cluster as u32,
                cluster_count: (i + 1 - first_cluster) as u32,
            });
            archives.push(bytes);
            current_raw.clear();
            first_cluster = i + 1;
            target_i += 1;
        }
    }

    Packed {
        manifest: Manifest {
            aabb,
            cluster_count: infos.len() as u32,
            level_count: h.level_count,
            total_vertices,
            total_triangles,
            source_triangles: h.mesh.triangle_count() as u32,
            archives: archive_infos,
        },
        clusters: infos,
        archives,
        raw_bytes: raw_total,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hierarchy::{build, BuildOptions};
    use crate::mesh::asteroid;
    use tessera_format::{decode_archive_table, decode_cluster};

    #[test]
    fn pack_and_decode_everything() {
        let m = asteroid(40, 80, 5);
        let h = build(
            &m,
            &BuildOptions {
                group_size: 8,
                verbose: false,
            },
        );
        let p = pack(&h, &DEFAULT_SCHEDULE);
        assert_eq!(p.archives.len(), p.manifest.archives.len());
        assert!(p.manifest.archives.len() >= 2);
        // Coarsest clusters come first.
        assert!(p.clusters[0].level as u32 == h.level_count - 1);
        let m2 = Manifest::decode(&p.manifest.encode()).unwrap();
        assert_eq!(m2, p.manifest);
        let mut verts = 0u32;
        for (ai, a) in m2.archives.iter().enumerate() {
            assert_eq!(p.archives[ai].len(), a.byte_len as usize);
            let t = decode_archive_table(&m2.aabb, &p.archives[ai]).unwrap();
            assert_eq!(t.clusters.len(), a.cluster_count as usize);
            let blobs = &p.archives[ai][t.blobs_offset..];
            for (k, c) in t.clusters.iter().enumerate() {
                assert_eq!(c.archive as usize, ai);
                assert_eq!(c.level, p.clusters[a.first_cluster as usize + k].level);
                let blob = &blobs[c.offset as usize..c.offset as usize + c.byte_len as usize];
                let (mut pp, mut n, mut i) = (Vec::new(), Vec::new(), Vec::new());
                let d = decode_cluster(&m2.aabb, blob, verts, &mut pp, &mut n, &mut i).unwrap();
                assert_eq!(d.vertex_count, c.vertex_count as usize);
                assert_eq!(d.triangle_count, c.triangle_count as usize);
                verts += d.vertex_count as u32;
                // Children range points at the next finer level.
                for ch in c.child_first..c.child_first + c.child_count as u32 {
                    assert_eq!(p.clusters[ch as usize].level + 1, c.level);
                }
            }
        }
        assert_eq!(verts, m2.total_vertices);
    }
}
