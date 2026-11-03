//! Android 的 Kotlin 调的 JNI 接口（`expo.modules.syncline.SynclineNative` 的静态方法），与 iOS 的 C 接口（`ffi` 模块）一一对应：
//! 句柄是 long，`next` 回空之后用 `free` 放掉（只放一次）。出错与 panic 都在这里接住，转成 Kotlin 的 `RuntimeException`，不越过 JNI。
//! 不该知道的：库里的事。
//! @see <https://docs.rs/jni/0.22.4/jni/>
//! @see <https://docs.oracle.com/en/java/javase/21/docs/specs/jni/design.html#resolving-native-method-names>
#![expect(unsafe_code, reason = "JNI 的入口要导出不改名的符号；句柄是 Kotlin 那边按约定传回的指针")]

use crate::{Handle, remove};
use jni::errors::ThrowRuntimeExAndDefault;
use jni::objects::{JClass, JObject, JString};
use jni::sys::jlong;
use jni::{Env, EnvUnowned};
use std::path::PathBuf;

/// # Safety
/// handle 来自 `start`、还没放掉。
unsafe fn handle<'a>(handle: jlong) -> &'a Handle {
    unsafe { &*(handle as *const Handle) }
}

fn text(env: &Env<'_>, text: &JString<'_>) -> jni::errors::Result<String> {
    text.try_to_string(env)
}

/// 跑一个入口：出错与 panic 转成 Kotlin 的 `RuntimeException`，回默认值
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

/// 删掉库文件：成功回空，出错回错误消息
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
