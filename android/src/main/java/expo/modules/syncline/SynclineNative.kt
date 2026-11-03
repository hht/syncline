package expo.modules.syncline

/** JNI interface for the native Rust sync engine (`rust/native`). */
internal object SynclineNative {
  init {
    System.loadLibrary("syncline_native")
  }

  @JvmStatic external fun start(path: String): Long

  @JvmStatic external fun send(handle: Long, call: String)

  @JvmStatic external fun next(handle: Long): String?

  @JvmStatic external fun shutdown(handle: Long)

  @JvmStatic external fun free(handle: Long)

  /** Removes database file, returning null on success or error message on failure. */
  @JvmStatic external fun remove(path: String): String?
}
