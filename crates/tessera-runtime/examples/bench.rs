//! Native benchmark: decode throughput and per-frame selection cost.
//! `cargo run --release -p tessera-runtime --example bench -- [tris]`
use std::time::Instant;
use tessera_runtime::{Runtime, View};
use tessera_pack::hierarchy::{build, BuildOptions};
use tessera_pack::mesh::asteroid;
use tessera_pack::pack::{pack, DEFAULT_SCHEDULE};

fn main() {
    let tris: usize = std::env::args()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(1_500_000);
    let rings = ((tris as f64 / 4.0).sqrt()).round() as usize;
    let mesh = asteroid(rings, rings * 2, 7);
    let h = build(
        &mesh,
        &BuildOptions {
            group_size: 8,
            verbose: false,
        },
    );
    let p = pack(&h, &DEFAULT_SCHEDULE);
    let total_bytes: usize = p.archives.iter().map(|a| a.len()).sum();
    println!(
        "model: {} source triangles, {} clusters, {} levels, {:.1} MB in {} archives",
        p.manifest.source_triangles,
        p.manifest.cluster_count,
        p.manifest.level_count,
        total_bytes as f64 / 1_048_576.0,
        p.archives.len()
    );

    let mut rt = Runtime::new(&p.manifest.encode()).unwrap();
    let t = Instant::now();
    for (i, a) in p.archives.iter().enumerate() {
        rt.add_archive(i, a).unwrap();
    }
    let dt = t.elapsed();
    println!(
        "decode: {:.1} ms for {:.1} MB -> {:.0} MB/s, {} vertices",
        dt.as_secs_f64() * 1e3,
        total_bytes as f64 / 1_048_576.0,
        total_bytes as f64 / 1_048_576.0 / dt.as_secs_f64(),
        rt.pool_vertex_count()
    );

    let fov: f32 = 60f32.to_radians();
    let f = 1.0 / (fov * 0.5).tan();
    for (distance, threshold) in [(2.2f32, 1.0f32), (2.2, 4.0), (5.0, 1.0), (20.0, 1.0)] {
        let mut vp = [0f32; 16];
        vp[0] = f / (16.0 / 9.0);
        vp[5] = f;
        vp[10] = -1.002;
        vp[11] = -1.0;
        vp[14] = -0.2 + 1.002 * distance;
        vp[15] = distance;
        let view = View {
            position: [0.0, 0.0, distance],
            view_proj: vp,
            viewport_height: 1080.0,
            fov_y: fov,
            threshold_px: threshold,
            frustum_cull: true,
        };
        let frames = 50;
        let t = Instant::now();
        let mut s = Default::default();
        for _ in 0..frames {
            s = rt.select(&view);
        }
        let per = t.elapsed().as_secs_f64() * 1e3 / frames as f64;
        println!("select d={distance} T={threshold}px: {:.2} ms/frame, {} clusters, {} triangles, coarsest level {}, culled {}", per, s.clusters, s.triangles, s.coarsest_level_in_cut, s.culled);
    }
}
