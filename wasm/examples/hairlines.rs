//! Finds hairline gaps in the lit area of a captured input (as bench.rs takes it): the lit area closed (grown by `radius` and
//! shrunk back) less the lit area itself is every dark gap narrower than twice the radius. For the single pass and for `tasks`
//! tasks united as the workers do: cargo run --release --example hairlines -- input.bin [tasks]
use f2e_grid::geometry::{Path, bounding_box, difference, signed_area, union, union_snapped};
use i_overlay::mesh::float::outline::offset::OutlineOffset;
use i_overlay::mesh::float::style::{LineJoin, OutlineStyle};

fn contours(paths: &[Path]) -> Vec<Vec<[f64; 2]>> {
	paths.iter().map(|path| path.chunks_exact(2).map(|point| [point[0], point[1]]).collect()).collect()
}

fn flatten(shapes: Vec<Vec<Vec<[f64; 2]>>>) -> Vec<Path> {
	shapes.into_iter().flatten().filter(|contour| contour.len() >= 3).map(|contour| contour.iter().flat_map(|point| [point[0], point[1]]).collect()).collect()
}

fn offset(paths: &[Path], distance: f64) -> Vec<Path> {
	let valid = contours(&union(paths));
	flatten(valid.outline(&OutlineStyle::new(distance).line_join(LineJoin::Miter(std::f64::consts::FRAC_PI_3))))
}

fn report(name: &str, lit: &[Path]) {
	let radius = 0.3;
	let closed = offset(&offset(lit, radius), -radius);
	let gaps = difference(&closed, lit);
	let area: f64 = gaps.iter().map(|path| signed_area(path)).sum();
	println!("{name}: lit area {:.1}, hairline gaps {} pieces, {:.1} px²", lit.iter().map(|path| signed_area(path)).sum::<f64>(), gaps.len(), area);
	let mut boxes: Vec<_> = gaps.iter().map(|path| (bounding_box([path], 0.0), signed_area(path))).collect();
	boxes.sort_by(|a, b| b.1.total_cmp(&a.1));
	for (b, area) in boxes.iter().take(8) {
		println!("   gap {:.2} px²: x {:.1}..{:.1} ({:.2} wide), y {:.1}..{:.1} ({:.2} tall)", area, b.min_x, b.max_x, b.max_x - b.min_x, b.min_y, b.max_y, b.max_y - b.min_y);
	}
}

fn main() {
	let mut args = std::env::args().skip(1);
	let bytes = std::fs::read(args.next().expect("an input file")).unwrap();
	let tasks: usize = args.next().map(|tasks| tasks.parse().unwrap()).unwrap_or(8);
	let input: Vec<f64> = bytes.chunks_exact(8).map(|chunk| f64::from_le_bytes(chunk.try_into().unwrap())).collect();
	report("single pass", &f2e_grid::lit_floors_from(&input));
	let prepared = f2e_grid::prepare(&input);
	let shares: Vec<Path> = (0..tasks).flat_map(|part| f2e_grid::light_task(&prepared, part, tasks)).collect();
	report(&format!("{tasks} tasks united"), &union_snapped(&shares, f2e_grid::SNAP_SCALE));
}
