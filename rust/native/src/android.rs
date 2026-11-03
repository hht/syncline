//! JNI interface called from Android Kotlin (`expo.modules.syncline.SynclineNative` static methods), matching the iOS C interface (`ffi`).
//! Handles are stored as `jlong` and freed with `free` once `next` returns null. Errors and panics are caught and converted to Kotlin
//! `RuntimeException` without unwinding across the JNI boundary.
//! What this module should not know: database contents or internal state machine rules.
//! @see <https://docs.rs/jni/0.22.4/jni/>
//! @see <https://docs.oracle.com/en/java/javase/21/docs/specs/jni/design.html#resolving-native-method-names>
#![expect(
    unsafe_code,
    reason = "JNI exports unmangled symbols; handles are pointers passed back from Kotlin by contract"
)]

use crate::{Handle, remove};
use jni::errors::ThrowRuntimeExAndDefault;
use jni::objects::{JClass, JObject, JString};
use jni::sys::jlong;
use jni::{Env, EnvUnowned};
use std::path::PathBuf;

/// # Safety
/// `handle` must originate from `start` and not have been freed yet.
unsafe fn handle<'a>(handle: jlong) -> &'a Handle {
    unsafe { &*(handle as *const Handle) }
}

fn text(env: &Env<'_>, text: &JString<'_>) -> jni::errors::Result<String> {
    text.try_to_string(env)
}

/// Executes an entry point: catches errors and panics, throws a Kotlin `RuntimeException`, and returns default.
fn guarded<'local, T: Default>(env: &mut EnvUnowned<'local>, body: impl FnOnce(&mut Env<'local>) -> jni::errors::Result<T>) -> T {
    env.with_env(body).resolve::<ThrowRuntimeExAndDefault>()
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_expo_modules_syncline_SynclineNative_start<'local>(
    mut env: EnvUnowned<'local>,
    _class: JClass<'local>,
    path: JString<'local>,
) -> jlong {
    guarded(&mut env, |env| {
        let path = PathBuf::from(text(env, &path)?);
        Ok(Box::into_raw(Box::new(Handle::start(path))) as jlong)
    })
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_expo_modules_syncline_SynclineNative_send<'local>(
    mut env: EnvUnowned<'local>,
    _class: JClass<'local>,
    handle: jlong,
    call: JString<'local>,
) {
    guarded(&mut env, |env| {
        let call = text(env, &call)?;
        unsafe { self::handle(handle) }.send(call);
        Ok(())
    });
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_expo_modules_syncline_SynclineNative_next<'local>(
    mut env: EnvUnowned<'local>,
    _class: JClass<'local>,
    handle: jlong,
) -> JObject<'local> {
    guarded(&mut env, |env| match unsafe { self::handle(handle) }.next() {
        Some(next) => Ok(JString::from_str(env, next)?.into()),
        None => Ok(JObject::null()),
    })
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_expo_modules_syncline_SynclineNative_shutdown<'local>(
    mut env: EnvUnowned<'local>,
    _class: JClass<'local>,
    handle: jlong,
) {
    guarded(&mut env, |_| {
        unsafe { self::handle(handle) }.shutdown();
        Ok(())
    });
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_expo_modules_syncline_SynclineNative_free<'local>(
    mut env: EnvUnowned<'local>,
    _class: JClass<'local>,
    handle: jlong,
) {
    guarded(&mut env, |_| {
        drop(unsafe { Box::from_raw(handle as *mut Handle) });
        Ok(())
    });
}

/// Removes database files: returns null on success, error message on failure.
#[unsafe(no_mangle)]
pub extern "system" fn Java_expo_modules_syncline_SynclineNative_remove<'local>(
    mut env: EnvUnowned<'local>,
    _class: JClass<'local>,
    path: JString<'local>,
) -> JObject<'local> {
    guarded(&mut env, |env| {
        let path = PathBuf::from(text(env, &path)?);
        match remove(&path) {
            Ok(()) => Ok(JObject::null()),
            Err(error) => Ok(JString::from_str(env, error.to_string())?.into()),
        }
    })
}
