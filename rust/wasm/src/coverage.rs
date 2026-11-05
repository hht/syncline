//! Coverage counters of an instrumented test build, read by the test runner after each test file.
//! @see <https://github.com/Amanieu/minicov/blob/v0.3.9/README.md>

use wasm_bindgen::prelude::*;

/// Returns the counters collected since the last call as `.profraw` bytes and resets them, so each test file's profile counts once.
#[wasm_bindgen]
#[must_use]
pub fn coverage() -> Vec<u8> {
    let mut profile = Vec::new();
    // Safety: wasm runs one thread, so nothing else touches the counters while they are copied.
    #[expect(unsafe_code, reason = "minicov reads the counters without locking")]
    unsafe {
        minicov::capture_coverage(&mut profile).expect("the build is instrumented for coverage");
    }
    minicov::reset_coverage();
    profile
}
