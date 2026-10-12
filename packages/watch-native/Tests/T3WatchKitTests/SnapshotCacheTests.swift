import Foundation
import Testing

@testable import T3WatchKit

@Suite struct SnapshotCacheTests {
  let t0 = Date(timeIntervalSince1970: 1_791_761_140)

  func tempDirectory() -> URL {
    FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
  }

  func summary(id: String = Fixtures.threadId, activity: String = "running") throws -> WatchThreadSummary {
    var summary = try Fixtures.summary(Fixtures.thread(activity: activity))
    summary.threadId = id
    return summary
  }

  @Test func roundTripsPageAndThreads() async throws {
    let dir = tempDirectory()
    let page = WatchThreadPage(items: [try summary()], nextCursor: "next", snapshotRevision: 278476)
    let cache = try SnapshotCache(directory: dir)
    try await cache.saveThreadsPage(page, fetchedAt: t0)
    try await cache.saveThread(try summary(), fetchedAt: t0)

    let reopened = try SnapshotCache(directory: dir)
    #expect(await reopened.threadsPage == CachedThreadPage(page: page, fetchedAt: t0))
    #expect(await reopened.thread(id: Fixtures.threadId) == CachedThread(summary: try summary(), fetchedAt: t0))
    #expect(await reopened.thread(id: "thread:missing") == nil)
  }

  @Test func overwritesPerThread() async throws {
    let cache = try SnapshotCache(directory: tempDirectory())
    try await cache.saveThread(try summary(activity: "running"), fetchedAt: t0)
    let later = t0.addingTimeInterval(5)
    try await cache.saveThread(try summary(activity: "completed"), fetchedAt: later)
    let cached = try #require(await cache.thread(id: Fixtures.threadId))
    #expect(cached.summary.activity == .completed && cached.fetchedAt == later)
  }

  @Test func unchangedSummaryWritesAreCoalesced() async throws {
    let cache = try SnapshotCache(directory: tempDirectory())
    try await cache.saveThread(try summary(), fetchedAt: t0)
    try await cache.saveThread(try summary(), fetchedAt: t0.addingTimeInterval(5))
    #expect(await cache.thread(id: Fixtures.threadId)?.fetchedAt == t0)
    let late = t0.addingTimeInterval(SnapshotCache.unchangedWriteInterval)
    try await cache.saveThread(try summary(), fetchedAt: late)
    #expect(await cache.thread(id: Fixtures.threadId)?.fetchedAt == late)
  }

  @Test func boundsThreadCountDroppingOldest() async throws {
    let dir = tempDirectory()
    let cache = try SnapshotCache(directory: dir, maxThreads: 3)
    for index in 0..<5 {
      try await cache.saveThread(try summary(id: "thread:\(index)"), fetchedAt: t0.addingTimeInterval(Double(index)))
    }
    // Refreshing an old entry moves it to the newest end.
    try await cache.saveThread(try summary(id: "thread:2", activity: "idle"), fetchedAt: t0.addingTimeInterval(10))
    let reopened = try SnapshotCache(directory: dir, maxThreads: 3)
    for (id, present) in [("thread:0", false), ("thread:1", false), ("thread:2", true), ("thread:3", true), ("thread:4", true)] {
      #expect((await reopened.thread(id: id) != nil) == present, "\(id)")
    }
  }

  @Test func corruptFileStartsEmpty() async throws {
    let dir = tempDirectory()
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    try Data("{not json".utf8).write(to: dir.appendingPathComponent("watch-snapshots.json"))
    #expect(await (try SnapshotCache(directory: dir)).threadsPage == nil)
  }

  @Test func clearForgetsEverything() async throws {
    let dir = tempDirectory()
    let cache = try SnapshotCache(directory: dir)
    try await cache.saveThread(try summary(), fetchedAt: t0)
    try await cache.clear()
    #expect(await (try SnapshotCache(directory: dir)).thread(id: Fixtures.threadId) == nil)
  }
}

@Suite struct FreshnessTests {
  let t0 = Date(timeIntervalSince1970: 1_791_761_140)

  @Test func staleAfterSixtySecondsOrAFailedRefresh() {
    let fresh = SnapshotFreshness(fetchedAt: t0, lastRefreshFailed: false)
    #expect(!fresh.isStale(now: t0.addingTimeInterval(SnapshotFreshness.staleAfter)))
    #expect(fresh.isStale(now: t0.addingTimeInterval(SnapshotFreshness.staleAfter + 1)))
    #expect(SnapshotFreshness(fetchedAt: t0, lastRefreshFailed: true).isStale(now: t0))
    #expect(SnapshotFreshness(fetchedAt: nil, lastRefreshFailed: false).isStale(now: t0))
  }

  @Test func generationGateDiscardsResultsOlderThanTheLastInvalidation() {
    var gate = GenerationGate()
    let slowRefresh = gate.current
    gate.advance()  // receipt accepted while the slow refresh was in flight
    let receiptRefresh = gate.current
    #expect(!gate.isCurrent(slowRefresh))
    #expect(gate.isCurrent(receiptRefresh))
  }
}
