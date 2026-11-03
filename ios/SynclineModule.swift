import ExpoModulesCore

/// JS 与 Rust 的设备一侧之间（rust/native）：每开一个库起一个句柄，调用照原样（JSON）交给它；一条读取线程反复等它交回的，转成 message 事件给 JS。
/// 交回空（库关了）时读取线程放掉句柄。库文件在 Application Support/Syncline 下（不给用户看、随系统备份）。
/// 开发时重新加载 JS，模块销毁：开着的库都关掉（新的 JS 会重新打开）。
/// 不该知道的：调用里是什么。
/// @see https://docs.expo.dev/modules/module-api/
/// @see https://developer.apple.com/documentation/foundation/filemanager/searchpathdirectory/applicationsupportdirectory
public class SynclineModule: Module {
  /// 开着的库，按 JS 那边的句柄号；改动与用句柄都在锁里，读取线程放掉句柄前先从这里删掉
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
