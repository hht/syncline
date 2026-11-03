package expo.modules.syncline

import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlin.concurrent.thread

/**
 * Bridges JavaScript and the native Rust sync engine (`rust/native`).
 *
 * Allocates a handle per opened database and forwards calls as raw JSON. A dedicated reader thread awaits emitted
 * responses and forwards them to JavaScript via `message` events. When null is returned (database closed), the reader thread
 * frees the handle. Database files are stored under the app database directory (`Context.getDatabasePath`).
 * Closes all active databases when the module is destroyed on JS reload during development.
 * What this class must not know: Payload contents inside calls and responses.
 * @see https://docs.expo.dev/modules/module-api/
 */
class SynclineModule : Module() {
  /** Active database handles keyed by JavaScript handle ID; mutations and access are synchronized on handles. */
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
