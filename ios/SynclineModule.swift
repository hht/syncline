import ExpoModulesCore

/// Bridges JavaScript and the native Rust sync engine (`rust/native`).
///
/// Allocates a handle per opened database and forwards calls as raw JSON. A dedicated reader thread awaits emitted
/// responses and forwards them to JavaScript via `message` events. When null is returned (database closed), the reader thread
/// frees the handle. Database files are stored under `Application Support/Syncline` (backed up with app data).
/// Closes all active databases when the module is destroyed on JS reload during development.
/// What this class must not know: Payload contents inside calls and responses.
/// @see https://docs.expo.dev/modules/module-api/
/// @see https://developer.apple.com/documentation/foundation/filemanager/searchpathdirectory/applicationsupportdirectory
public class SynclineModule: Module {
  /// Active database handles keyed by JavaScript handle ID; mutations and access are protected by lock.
  private var handles: [Int: OpaquePointer] = [:]
  private var next = 0
  private let lock = NSLock()

  public func definition() -> ModuleDefinition {
    Name("Syncline")
    Events("message")

    Function("start") { (name: String) -> Int in
      let handle = syncline_start(try Self.path(name))
      let id = lock.withLock {
        next += 1
        handles[next] = handle
        return next
      }
      let reader = Thread { [weak self] in
        while let text = syncline_next(handle) {
          let data = String(cString: text)
          syncline_string_free(text)
          self?.sendEvent("message", ["handle": id, "data": data])
        }
        self?.lock.withLock { _ = self?.handles.removeValue(forKey: id) }
        syncline_free(handle)
      }
      reader.name = "syncline-reader"
      reader.start()
      return id
    }

    Function("send") { (handle: Int, call: String) in
      lock.withLock {
        if let opened = handles[handle] { syncline_send(opened, call) }
      }
    }

    AsyncFunction("remove") { (name: String) in
      if let error = syncline_remove(try Self.path(name)) {
        let message = String(cString: error)
        syncline_string_free(error)
        throw Exception(name: "SynclineRemove", description: message)
      }
    }

    OnDestroy {
      lock.withLock {
        for handle in handles.values { syncline_shutdown(handle) }
      }
    }
  }

  private static func path(_ name: String) throws -> String {
    let directory = try FileManager.default
      .url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
      .appendingPathComponent("Syncline", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    return directory.appendingPathComponent("\(name).db").path
  }
}
