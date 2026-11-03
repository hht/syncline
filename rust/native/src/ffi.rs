//! C interface called by iOS Swift (declared in native C header). Handle and string ownership: handles returned by `syncline_start`
//! must be freed by caller using `syncline_free` once `syncline_next` returns null (freed exactly once, never used after);
//! strings returned by `syncline_next` and `syncline_remove` must be freed with `syncline_string_free`.
//! Incoming strings must be null-terminated UTF-8, valid for the duration of the call.
//! What this module should not know: database contents or internal state machine rules.
//! @see <https://doc.rust-lang.org/nomicon/ffi.html>
#![expect(unsafe_code, reason = "C interface: pointers passed by caller under the contract above")]

use crate::{Handle, remove};
use std::ffi::{CStr, CString, c_char};
use std::path::PathBuf;

/// Spawns the sync thread for a database (database opens upon receiving the first open call).
///
/// # Safety
/// `path` must point to a valid null-terminated C string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn syncline_start(path: *const c_char) -> *mut Handle {
    let path = PathBuf::from(unsafe { text(path) });
    Box::into_raw(Box::new(Handle::start(path)))
}

/// Delivers a call from JS (JSON string).
///
/// # Safety
/// `handle` must originate from `syncline_start` and not have been freed; `call` must be a valid null-terminated C string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn syncline_send(handle: *const Handle, call: *const c_char) {
    unsafe { &*handle }.send(unsafe { text(call) });
}

/// Waits for instructions to deliver back to JS (JSON array); returns null once closed and drained.
///
/// # Safety
/// `handle` must originate from `syncline_start` and not have been freed.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn syncline_next(handle: *const Handle) -> *mut c_char {
    unsafe { &*handle }.next().map_or(std::ptr::null_mut(), owned)
}

/// Closes the database (without waiting for JS close); subsequent `syncline_next` calls drain remaining instructions then return null.
///
/// # Safety
/// `handle` must originate from `syncline_start` and not have been freed.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn syncline_shutdown(handle: *const Handle) {
    unsafe { &*handle }.shutdown();
}

/// Frees the handle, waiting for the sync thread to exit and close the database file.
///
/// # Safety
/// `handle` must originate from `syncline_start` and must be freed exactly once.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn syncline_free(handle: *mut Handle) {
    drop(unsafe { Box::from_raw(handle) });
}

/// Removes database files at `path` (database must be closed first); returns null on success, error message on failure.
///
/// # Safety
/// `path` must point to a valid null-terminated C string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn syncline_remove(path: *const c_char) -> *mut c_char {
    let path = PathBuf::from(unsafe { text(path) });
    remove(&path).map_or_else(|error| owned(error.to_string()), |()| std::ptr::null_mut())
}

/// Frees a string returned by `syncline_next` or `syncline_remove`.
///
/// # Safety
/// `text` must originate from `syncline_next` or `syncline_remove` and must be freed exactly once.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn syncline_string_free(text: *mut c_char) {
    drop(unsafe { CString::from_raw(text) });
}

/// # Safety
/// `pointer` must point to a valid null-terminated C string.
unsafe fn text(pointer: *const c_char) -> String {
    unsafe { CStr::from_ptr(pointer) }.to_string_lossy().into_owned()
}

// JSON and error messages contain no null bytes (encoded as \u0000).
fn owned(text: String) -> *mut c_char {
    CString::new(text)
        .expect("JSON and error messages contain no null bytes")
        .into_raw()
}
