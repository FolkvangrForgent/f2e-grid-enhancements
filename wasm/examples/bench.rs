//! Replays a captured input buffer (little-endian f64s, as scripts/perception/floors.js writes it) natively and prints
//! the time per step: cargo run --release --example bench --features profile -- input.bin [runs]
fn main() {
	let mut args = std::env::args().skip(1);
	let path = args.next().expect("an input file");
	let runs: usize = args.next().map(|runs| runs.parse().unwrap()).unwrap_or(5);
	let bytes = std::fs::read(path).unwrap();
	let input: Vec<f64> = bytes.chunks_exact(8).map(|chunk| f64::from_le_bytes(chunk.try_into().unwrap())).collect();
	f2e_grid::lit_floors_from(&input);
	#[cfg(feature = "profile")]
	f2e_grid::profile::take();
	let started = std::time::Instant::now();
	let mut lit = Vec::new();
	for _ in 0..runs {
		lit = f2e_grid::lit_floors_from(&input);
	}
	let area: f64 = lit
		.iter()
		.map(|path| {
			let count = path.len();
			(0..count / 2).map(|index| path[index * 2] * path[(index * 2 + 3) % count] - path[(index * 2 + 2) % count] * path[index * 2 + 1]).sum::<f64>() / 2.0
		})
		.sum();
	// pieces and holes the visualizer drops as rounding slivers (shape.js: under 4 px², or thinner than half a pixel)
	let slivers = lit
		.iter()
		.filter(|path| {
			let count = path.len();
			let area = ((0..count / 2).map(|index| path[index * 2] * path[(index * 2 + 3) % count] - path[(index * 2 + 2) % count] * path[index * 2 + 1]).sum::<f64>() / 2.0).abs();
			let perimeter: f64 = (0..count / 2).map(|index| (path[(index * 2 + 2) % count] - path[index * 2]).hypot(path[(index * 2 + 3) % count] - path[index * 2 + 1])).sum();
			area < 4.0 || 2.0 * area / perimeter.max(1e-9) < 0.5
		})
		.count();
	println!("slivers (dropped downstream): {slivers}");
	println!("{:.1} ms per pass ({} lit paths, lit area {:.1})", started.elapsed().as_secs_f64() * 1000.0 / runs as f64, lit.len(), area);
	#[cfg(feature = "profile")]
	for (name, milliseconds, count) in f2e_grid::profile::take() {
		println!("{:>9.2} ms {:>7} calls  {}", milliseconds / runs as f64, count / runs as u64, name);
	}
}
