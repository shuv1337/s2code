import Foundation

public struct CachedThreadPage: Codable, Hashable, Sendable {
  public var page: WatchThreadPage
  public var fetchedAt: Date
}

public struct CachedThread: Codable, Hashable, Sendable {
  public var summary: WatchThreadSummary
  public var fetchedAt: Date
}

/// Last known snapshots, so the app can render with a visible age before (or instead of) a
/// successful refresh. Display only: anything that sends re-fetches first.
public actor SnapshotCache {
  private struct Snapshot: Codable {
    var threadsPage: CachedThreadPage?
    /// Oldest first.
    var threads: [CachedThread] = []
  }

  /// An unchanged summary is rewritten at most this often, so polling does not write every few
  /// seconds. The persisted age can lag by this much, which only makes it look older.
  public static let unchangedWriteInterval: TimeInterval = 30

  public nonisolated let fileURL: URL
  public nonisolated let maxThreads: Int
  private var snapshot: Snapshot

  public init(directory: URL, fileName: String = "watch-snapshots.json", maxThreads: Int = 50)
    throws
  {
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    fileURL = directory.appendingPathComponent(fileName)
    self.maxThreads = maxThreads
    // A cache that fails to decode (e.g. after a schema change) is discarded, never fatal.
    snapshot =
      (try? Data(contentsOf: fileURL)).flatMap { try? JSONDecoder.watch.decode(Snapshot.self, from: $0) }
      ?? Snapshot()
  }

  public static func applicationSupport() throws -> SnapshotCache {
    try SnapshotCache(directory: WatchStorage.directory())
  }

  public var threadsPage: CachedThreadPage? { snapshot.threadsPage }

  public func thread(id: String) -> CachedThread? {
    snapshot.threads.last { $0.summary.threadId == id }
  }

  public func saveThreadsPage(_ page: WatchThreadPage, fetchedAt: Date) throws {
    snapshot.threadsPage = CachedThreadPage(page: page, fetchedAt: fetchedAt)
    try persist()
  }

  public func saveThread(_ summary: WatchThreadSummary, fetchedAt: Date) throws {
    if let existing = thread(id: summary.threadId), existing.summary == summary,
      fetchedAt.timeIntervalSince(existing.fetchedAt) < Self.unchangedWriteInterval
    {
      return
    }
    snapshot.threads.removeAll { $0.summary.threadId == summary.threadId }
    snapshot.threads.append(CachedThread(summary: summary, fetchedAt: fetchedAt))
    if snapshot.threads.count > maxThreads {
      snapshot.threads.removeFirst(snapshot.threads.count - maxThreads)
    }
    try persist()
  }

  /// Call when the paired environment changes.
  public func clear() throws {
    snapshot = Snapshot()
    try persist()
  }

  private func persist() throws {
    try JSONEncoder.watch.encode(snapshot).write(to: fileURL, options: [.atomic])
  }
}

/// A snapshot is stale when its last successful fetch is older than `staleAfter` or the most
/// recent refresh failed. Stale snapshots are shown, but not used to start an instruction.
public struct SnapshotFreshness: Hashable, Sendable {
  public static let staleAfter: TimeInterval = 60

  public var fetchedAt: Date?
  public var lastRefreshFailed: Bool

  public init(fetchedAt: Date?, lastRefreshFailed: Bool) {
    self.fetchedAt = fetchedAt
    self.lastRefreshFailed = lastRefreshFailed
  }

  public func isStale(now: Date) -> Bool {
    guard let fetchedAt, !lastRefreshFailed else { return true }
    return now.timeIntervalSince(fetchedAt) > Self.staleAfter
  }
}

/// Orders overlapping refreshes: a refresh keeps its result only if nothing invalidated the
/// snapshot since it began. Capture `current` before the request, check `isCurrent` after.
public struct GenerationGate: Hashable, Sendable {
  public private(set) var current = 0

  public init() {}

  public mutating func advance() { current &+= 1 }

  public func isCurrent(_ generation: Int) -> Bool { generation == current }
}
