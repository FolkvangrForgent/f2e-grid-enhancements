//! Time and counts per step, with the `profile` feature (examples/bench.rs prints them); nothing without it.

#[cfg(feature = "profile")]
mod enabled {
	use std::cell::RefCell;
	use std::collections::BTreeMap;
	use std::time::Instant;

	thread_local! {
		static TOTALS: RefCell<BTreeMap<&'static str, (f64, u64)>> = const { RefCell::new(BTreeMap::new()) };
	}

	pub fn timed<T>(name: &'static str, run: impl FnOnce() -> T) -> T {
		let started = Instant::now();
		let result = run();
		let elapsed = started.elapsed().as_secs_f64() * 1000.0;
		TOTALS.with(|totals| {
			let mut totals = totals.borrow_mut();
			let entry = totals.entry(name).or_insert((0.0, 0));
			entry.0 += elapsed;
			entry.1 += 1;
		});
		result
	}

	pub fn take() -> Vec<(&'static str, f64, u64)> {
		TOTALS.with(|totals| std::mem::take(&mut *totals.borrow_mut()).into_iter().map(|(name, (ms, count))| (name, ms, count)).collect())
	}
}

#[cfg(feature = "profile")]
pub use enabled::{take, timed};

#[cfg(not(feature = "profile"))]
#[inline(always)]
pub fn timed<T>(_name: &'static str, run: impl FnOnce() -> T) -> T {
	run()
}
