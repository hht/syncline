package expo.modules.syncline

import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlin.concurrent.thread

/**
 * JS 与 Rust 的设备一侧之间（rust/native）：每开一个库起一个句柄，调用照原样（JSON）交给它；一条读取线程反复等它交回的，转成 message 事件给 JS。
 * 交回空（库关了）时读取线程放掉句柄。库文件在 App 的数据库目录（Context.getDatabasePath）。
 * 开发时重新加载 JS，模块销毁：开着的库都关掉（新的 JS 会重新打开）。
 * 不该知道的：调用里是什么。
 * @see https://docs.expo.dev/modules/module-api/
 */
class SynclineModule : Module() {
  /** 开着的库，按 JS 那边的句柄号；改动与用句柄都在锁里，读取线程放掉句柄前先从这里删掉 */
  private val handles = HashMap<Int, Long>()
  private var next = 0

  override fun definition() = ModuleDefinition {
    Name("Syncline")
    Events("message")

    Function("start") { name: String ->
      val handle = SynclineNative.start(path(name))
      val id = synchronized(handles) {
        next += 1
        handles[next] = handle
        next
      }
      thread(name = "syncline-reader") {
        while (true) {
          val data = SynclineNative.next(handle) ?: break
          sendEvent("message", mapOf("handle" to id, "data" to data))
        }
        synchronized(handles) { handles.remove(id) }
        SynclineNative.free(handle)
      }
      id
    }

    Function("send") { handle: Int, call: String ->
      synchronized(handles) { handles[handle]?.let { SynclineNative.send(it, call) } }
    }

    AsyncFunction("remove") { name: String ->
      SynclineNative.remove(path(name))?.let { throw CodedException(it) }
    }

    OnDestroy {
      synchronized(handles) { handles.values.forEach(SynclineNative::shutdown) }
    }
  }

  private fun path(name: String): String {
    val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
    val file = context.getDatabasePath("$name.db")
    file.parentFile?.mkdirs()
    return file.path
  }
}
