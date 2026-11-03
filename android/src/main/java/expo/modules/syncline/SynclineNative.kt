package expo.modules.syncline

/** Rust 的设备一侧（rust/native/src/android.rs）的 JNI 接口；句柄的归属见那里 */
internal object SynclineNative {
  init {
    System.loadLibrary("syncline_native")
  }

  @JvmStatic external fun start(path: String): Long

  @JvmStatic external fun send(handle: Long, call: String)

  @JvmStatic external fun next(handle: Long): String?

  @JvmStatic external fun shutdown(handle: Long)

  @JvmStatic external fun free(handle: Long)

  /** 删掉库文件：成功回空，出错回错误消息 */
  @JvmStatic external fun remove(path: String): String?
}
