//! Container format for streamed virtualized geometry.
//!
//! A packed model is a tiny *manifest* (bounds, totals, archive table) plus N
//! *archives*. Every cluster (a meshlet of up to 64 vertices and 128 triangles)
//! lives in exactly one archive as a small self-contained blob: quantized
//! positions, octahedral normals and 8-bit local indices. Each archive starts
//! with the LOD records of the clusters it carries, so the runtime only ever
//! knows about clusters it has loaded and the first frame needs nothing but
//! the manifest and the first archive.
//!
//! The manifest carries, for every cluster, the two error/bounds pairs the LOD
//! cut needs: the error introduced when this cluster was produced (`lod_*`) and
//! the error of the coarser cluster that will replace it (`parent_*`). All
//! clusters generated from one simplification group share the same `lod_*`
//! values, and all clusters that belong to that group share the same `parent_*`
//! values, which keeps the per-frame decision consistent across the hierarchy.
//!
//! Everything is little-endian. The crate has no dependencies, so it compiles
//! to WebAssembly unchanged.

pub mod codec;
pub mod manifest;
pub mod quant;

pub use codec::{decode_cluster, encode_cluster, ClusterBlob, DecodedCluster};
pub use manifest::{
    decode_archive_table, encode_archive, ArchiveInfo, ArchiveTable, ClusterInfo, Manifest,
    ARCHIVE_MAGIC, MANIFEST_MAGIC,
};
pub use quant::{Aabb, Sphere};

/// Maximum vertices per cluster. Local indices are stored as `u8`.
pub const MAX_CLUSTER_VERTICES: usize = 64;
/// Maximum triangles per cluster.
pub const MAX_CLUSTER_TRIANGLES: usize = 128;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn limits_fit_the_blob_layout() {
        assert!(MAX_CLUSTER_VERTICES <= 256 && MAX_CLUSTER_TRIANGLES <= 255);
    }
}
