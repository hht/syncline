//! iOS 的 Swift 调的 C 接口（声明在 `ios/syncline.h`）。句柄与字符串的归属：`syncline_start` 给出的句柄由调用方在 `syncline_next`
//! 回空之后用 `syncline_free` 放掉（只放一次，之后不再用它）；`syncline_next` 与 `syncline_remove` 给出的字符串用 `syncline_string_free` 放掉。
//! 传进来的字符串是 UTF-8、以 0 结尾，调用期间有效。
//! 不该知道的：库里的事。
//! @see <https://doc.rust-lang.org/nomicon/ffi.html>
#![expect(unsafe_code, reason = "C 接口：指针由调用方按上面的约定传入")]

use crate::{Handle, remove};
use std::ffi::{CStr, CString, c_char};
use std::path::PathBuf;

/// 起一个库的核心线程（库在收到 open 调用时才打开）
///
/// # Safety
/// path 是有效的 C 字符串。
#[unsafe(no_mangle)]
pub unsafe extern "C" fn syncline_start(path: *const c_char) -> *mut Handle {
    let path = PathBuf::from(unsafe { text(path) });
    Box::into_raw(Box::new(Handle::start(path)))
}

/// 交来 JS 的一次调用（JSON）
///
/// # Safety
/// handle 来自 `syncline_start`、还没放掉；call 是有效的 C 字符串。
#[unsafe(no_mangle)]
pub unsafe extern "C" fn syncline_send(handle: *const Handle, call: *const c_char) {
    unsafe { &*handle }.send(unsafe { text(call) });
}

/// 等着取交回 JS 的（JSON 数组）；库关了、取完了回空
///
/// # Safety
/// handle 来自 `syncline_start`、还没放掉。
#[unsafe(no_mangle)]
pub unsafe extern "C" fn syncline_next(handle: *const Handle) -> *mut c_char {
    unsafe { &*handle }.next().map_or(std::ptr::null_mut(), owned)
}

/// 关库（不等 JS 的 close），之后 `syncline_next` 取完剩下的回空
///
/// # Safety
/// handle 来自 `syncline_start`、还没放掉。
#[unsafe(no_mangle)]
pub unsafe extern "C" fn syncline_shutdown(handle: *const Handle) {
    unsafe { &*handle }.shutdown();
}

/// 放掉句柄：等核心线程结束（库文件关掉）
///
/// # Safety
/// handle 来自 `syncline_start`、只放一次，之后不再用。
#[unsafe(no_mangle)]
pub unsafe extern "C" fn syncline_free(handle: *mut Handle) {
    drop(unsafe { Box::from_raw(handle) });
}

/// 删掉 path 上的库文件（库要先关掉）：成功回空，出错回错误消息
///
/// # Safety
/// path 是有效的 C 字符串。
#[unsafe(no_mangle)]
pub unsafe extern "C" fn syncline_remove(path: *const c_char) -> *mut c_char {
    let path = PathBuf::from(unsafe { text(path) });
    remove(&path).map_or_else(|error| owned(error.to_string()), |()| std::ptr::null_mut())
}

/// 放掉这里给出的字符串
///
/// # Safety
/// text 来自 `syncline_next` 或 `syncline_remove`、只放一次。
#[unsafe(no_mangle)]
pub unsafe extern "C" fn syncline_string_free(text: *mut c_char) {
    drop(unsafe { CString::from_raw(text) });
}

/// # Safety
/// pointer 是有效的 C 字符串。
unsafe fn text(pointer: *const c_char) -> String {
    unsafe { CStr::from_ptr(pointer) }.to_string_lossy().into_owned()
}

/// JSON 与错误消息里没有 0 字节（JSON 把它写成 \u0000）
fn owned(text: String) -> *mut c_char {
    CString::new(text).expect("JSON 与错误消息里没有 0 字节").into_raw()
}
