use std::fs;
use std::path::PathBuf;
use std::time::Instant;
use tessera_pack::hierarchy::{build, BuildOptions};
use tessera_pack::mesh::{asteroid, load_obj, terrain, Mesh};
use tessera_pack::pack::{pack, DEFAULT_SCHEDULE};

const USAGE: &str = "tessera-pack --out <dir> [--shape asteroid|terrain] [--tris N] [--seed S] [--obj file.obj] [--group-size 8]

Builds the cluster LOD hierarchy for a procedural or OBJ mesh and writes
<dir>/model.tsm (manifest) and <dir>/archive-<i>.tsa.";

struct Args {
    out: PathBuf,
    shape: String,
    tris: usize,
    seed: u32,
    obj: Option<PathBuf>,
    group_size: usize,
}

fn parse() -> Result<Args, String> {
    let mut a = Args {
        out: PathBuf::new(),
        shape: "asteroid".into(),
        tris: 1_500_000,
        seed: 7,
        obj: None,
        group_size: 8,
    };
    let mut it = std::env::args().skip(1);
    while let Some(k) = it.next() {
        let mut val = || it.next().ok_or_else(|| format!("missing value for {k}"));
        match k.as_str() {
            "--out" => a.out = PathBuf::from(val()?),
            "--shape" => a.shape = val()?,
            "--tris" => a.tris = val()?.parse().map_err(|_| "bad --tris")?,
            "--seed" => a.seed = val()?.parse().map_err(|_| "bad --seed")?,
            "--obj" => a.obj = Some(PathBuf::from(val()?)),
            "--group-size" => a.group_size = val()?.parse().map_err(|_| "bad --group-size")?,
            "-h" | "--help" => return Err(USAGE.into()),
            other => return Err(format!("unknown argument {other}\n{USAGE}")),
        }
    }
    if a.out.as_os_str().is_empty() {
        return Err(USAGE.into());
    }
    Ok(a)
}

fn source(a: &Args) -> Result<Mesh, String> {
    if let Some(p) = &a.obj {
        return load_obj(p);
    }
    match a.shape.as_str() {
        "asteroid" => {
            // rings * segments * 2 triangles, segments = 2 * rings.
            let rings = ((a.tris as f64 / 4.0).sqrt()).round().max(8.0) as usize;
            Ok(asteroid(rings, rings * 2, a.seed))
        }
        "terrain" => {
            let n = ((a.tris as f64 / 2.0).sqrt()).round().max(8.0) as usize;
            Ok(terrain(n, a.seed))
        }
        other => Err(format!("unknown shape {other}")),
    }
}

fn main() {
    let args = match parse() {
        Ok(a) => a,
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(2);
        }
    };
    let t0 = Instant::now();
    let mesh = source(&args).unwrap_or_else(|e| {
        eprintln!("{e}");
        std::process::exit(1)
    });
    eprintln!(
        "source: {} vertices, {} triangles ({:.1?})",
        mesh.positions.len(),
        mesh.triangle_count(),
        t0.elapsed()
    );

    let t1 = Instant::now();
    let h = build(
        &mesh,
        &BuildOptions {
            group_size: args.group_size,
            verbose: true,
        },
    );
    eprintln!(
        "hierarchy: {} clusters, {} levels ({:.1?})",
        h.clusters.len(),
        h.level_count,
        t1.elapsed()
    );

    let t2 = Instant::now();
    let p = pack(&h, &DEFAULT_SCHEDULE);
    fs::create_dir_all(&args.out).expect("create out dir");
    fs::write(args.out.join("model.tsm"), p.manifest.encode()).expect("write manifest");
    let mut total = 0usize;
    for (i, a) in p.archives.iter().enumerate() {
        fs::write(args.out.join(format!("archive-{i}.tsa")), a).expect("write archive");
        total += a.len();
        let info = &p.manifest.archives[i];
        eprintln!(
            "archive-{i}: {} clusters, levels {}..{}, {:.1} KB",
            info.cluster_count,
            p.clusters[(info.first_cluster + info.cluster_count - 1) as usize].level,
            p.clusters[info.first_cluster as usize].level,
            a.len() as f64 / 1024.0
        );
    }
    eprintln!(
        "packed: manifest {} B, archives {:.2} MB (blobs {:.2} MB), pool {} vertices / {} triangles ({:.1?})",
        p.manifest.encode().len(),
        total as f64 / 1_048_576.0,
        p.raw_bytes as f64 / 1_048_576.0,
        p.manifest.total_vertices,
        p.manifest.total_triangles,
        t2.elapsed()
    );
}
