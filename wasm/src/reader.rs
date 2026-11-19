//! Reads the flat f64 buffers JavaScript writes: the floor lighting's input (lib.rs), and scene uploads and raycast queries
//! (store.rs, raycast.rs). Counts and flags are f64s too; paths are a count, then each path's point count and coordinates.

use crate::geometry::Path;

pub struct Reader<'a> {
	pub data: &'a [f64],
	pub at: usize,
}

impl<'a> Reader<'a> {
	pub fn new(data: &'a [f64]) -> Self {
		Reader { data, at: 0 }
	}

	pub fn next(&mut self) -> f64 {
		let value = self.data[self.at];
		self.at += 1;
		value
	}

	pub fn count(&mut self) -> usize {
		self.next() as usize
	}

	pub fn flag(&mut self) -> bool {
		self.next() != 0.0
	}

	/// A document or primitive index, or -1 for none.
	pub fn index(&mut self) -> i32 {
		self.next() as i32
	}

	pub fn take(&mut self, length: usize) -> &'a [f64] {
		let slice = &self.data[self.at..self.at + length];
		self.at += length;
		slice
	}

	/// A count, then that many f64s.
	pub fn list(&mut self) -> Vec<f64> {
		let length = self.count();
		self.take(length).to_vec()
	}

	/// A count, then that many indices.
	pub fn indices(&mut self) -> Vec<i32> {
		let length = self.count();
		self.take(length).iter().map(|&value| value as i32).collect()
	}

	pub fn paths(&mut self) -> Vec<Path> {
		let count = self.count();
		(0..count)
			.map(|_| {
				let points = self.count();
				self.take(points * 2).to_vec()
			})
			.collect()
	}
}
