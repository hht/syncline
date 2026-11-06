//! SQLite's memory allocator in test builds (feature `testing`): the default one, except that the first allocation after `starve` fails,
//! as running out of memory would, the way SQLite's own tests inject out-of-memory errors. Installed before SQLite initializes, since it
//! takes an allocator only then. Connections get no lookaside memory, which would serve small allocations without the allocator.
//! What this module should not know: what SQLite is doing when an allocation fails, or why it fails.
//! @see <https://sqlite.org/c3ref/c_config_covering_index_scan.html#sqliteconfigmalloc>
//! @see <https://sqlite.org/c3ref/mem_methods.html>
//! @see <https://sqlite.org/malloc.html#lookaside>
//! @see <https://sqlite.org/src/file?name=src/test_malloc.c&ci=version-3.54.1>

use sqlite_wasm_rs::{
    SQLITE_CONFIG_GETMALLOC, SQLITE_CONFIG_LOOKASIDE, SQLITE_CONFIG_MALLOC, SQLITE_OK, sqlite3_config, sqlite3_mem_methods,
};
use std::cell::Cell;
use std::ffi::{c_int, c_void};
use std::sync::Once;

thread_local! {
    /// SQLite's default allocator, which this one passes through to.
    static DEFAULT: Cell<Option<sqlite3_mem_methods>> = const { Cell::new(None) };
    /// Whether the next allocation fails.
    static STARVED: Cell<bool> = const { Cell::new(false) };
}

/// Makes the next allocation fail, or with false, lets it succeed again.
pub fn starve(starved: bool) {
    STARVED.set(starved);
}

/// Installs the allocator once.
///
/// # Panics
/// Panics if SQLite has already initialized.
pub fn install() {
    static INSTALLED: Once = Once::new();
    #[expect(
        unsafe_code,
        reason = "SQLite takes its allocator as C function pointers through a variadic call; it copies the methods it is given"
    )]
    INSTALLED.call_once(|| unsafe {
        let mut methods = std::mem::zeroed::<sqlite3_mem_methods>();
        assert_eq!(
            sqlite3_config(SQLITE_CONFIG_GETMALLOC, &raw mut methods),
            SQLITE_OK,
            "SQLite has not initialized"
        );
        DEFAULT.set(Some(methods));
        methods.xMalloc = Some(malloc);
        methods.xRealloc = Some(realloc);
        assert_eq!(
            sqlite3_config(SQLITE_CONFIG_MALLOC, &raw const methods),
            SQLITE_OK,
            "SQLite has not initialized"
        );
        assert_eq!(
            sqlite3_config(SQLITE_CONFIG_LOOKASIDE, 0 as c_int, 0 as c_int),
            SQLITE_OK,
            "SQLite has not initialized"
        );
    });
}

fn default() -> sqlite3_mem_methods {
    DEFAULT.get().expect("installed before SQLite allocates")
}

#[expect(unsafe_code, reason = "SQLite's allocator interface is C")]
unsafe extern "C" fn malloc(size: c_int) -> *mut c_void {
    if STARVED.replace(false) {
        return std::ptr::null_mut();
    }
    unsafe { default().xMalloc.expect("SQLite's default allocator allocates")(size) }
}

#[expect(unsafe_code, reason = "SQLite's allocator interface is C")]
unsafe extern "C" fn realloc(allocation: *mut c_void, size: c_int) -> *mut c_void {
    if STARVED.replace(false) {
        return std::ptr::null_mut();
    }
    unsafe { default().xRealloc.expect("SQLite's default allocator reallocates")(allocation, size) }
}
