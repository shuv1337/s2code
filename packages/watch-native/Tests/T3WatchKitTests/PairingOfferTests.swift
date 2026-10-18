import Foundation
import Testing

@testable import T3WatchKit

private enum PairingAttemptFailure: Error {
  case transport
}

@MainActor
private final class PairingAttemptHarness {
  private var completions: [Int: CheckedContinuation<Void, any Error>] = [:]
  private var startWaiters: [Int: CheckedContinuation<Void, Never>] = [:]
  private(set) var offers: [UUID] = []

  func attempt(_ offer: WatchPairingOffer) async throws {
    offers.append(offer.id)
    let number = offers.count
    startWaiters.removeValue(forKey: number)?.resume()
    try await withCheckedThrowingContinuation { completions[number] = $0 }
  }

  func waitUntilStarted(_ number: Int) async {
    if offers.count >= number { return }
    await withCheckedContinuation { startWaiters[number] = $0 }
  }

  func finish(_ number: Int, with result: Result<Void, any Error>) {
    completions.removeValue(forKey: number)?.resume(with: result)
  }
}

struct PairingOfferTests {
  private let origin = URL(string: "https://watch-pairing.example")!

  private func offer(
    id: UUID = UUID(), origin: URL? = nil, issuedAt: Date, expiresAt: Date,
    mode: WatchConnectionMode = .phone
  ) -> WatchPairingOffer {
    WatchPairingOffer(
      id: id, origin: origin ?? self.origin, credential: "watch.credential", mode: mode,
      label: "Test",
      issuedAt: issuedAt, expiresAt: expiresAt)
  }

  @Test func unreachablePhoneOfferProcessesAfterReachabilityReturns() throws {
    let now = Date(timeIntervalSince1970: 1_000)
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let expected = offer(issuedAt: now, expiresAt: now.addingTimeInterval(300))
    let store = try WatchPairingOfferStore(directory: directory, now: now)

    #expect(try store.enqueue(expected, now: now))
    #expect(try store.next(now: now, phoneReachable: false) == nil)

    let restored = try WatchPairingOfferStore(directory: directory, now: now)
    let ready = try restored.next(now: now, phoneReachable: true)
    #expect(ready == expected)
    try restored.remove(try #require(ready).id)
    #expect(try restored.next(now: now, phoneReachable: true) == nil)
  }

  @Test func expiredOfferIsDropped() throws {
    let now = Date(timeIntervalSince1970: 2_000)
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let store = try WatchPairingOfferStore(directory: directory, now: now)
    let expired = offer(
      issuedAt: now.addingTimeInterval(-301), expiresAt: now.addingTimeInterval(-1))

    let accepted = try store.enqueue(expired, now: now)
    #expect(!accepted)
    #expect(try store.next(now: now, phoneReachable: true) == nil)
    #expect(try WatchPairingOfferStore(directory: directory, now: now)
      .next(now: now, phoneReachable: true) == nil)
  }

  @Test func loadPrunesExpiredOffersAndExcludesFileFromBackups() throws {
    let now = Date(timeIntervalSince1970: 2_500)
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let store = try WatchPairingOfferStore(directory: directory, now: now)
    #expect(try store.enqueue(
      offer(issuedAt: now, expiresAt: now.addingTimeInterval(10)), now: now))

    let restored = try WatchPairingOfferStore(
      directory: directory, now: now.addingTimeInterval(11))
    #expect(try restored.next(now: now.addingTimeInterval(11), phoneReachable: true) == nil)
    let values = try restored.fileURL.resourceValues(forKeys: [.isExcludedFromBackupKey])
    #expect(values.isExcludedFromBackup == true)
  }

  @Test func delayedOfferIssuedBeforeRemovalIsIgnored() {
    let issuedAt = Date(timeIntervalSince1970: 3_000)
    let removedAt = issuedAt.addingTimeInterval(10)
    var queue = WatchPairingOfferQueue()
    queue.setRemovalCutoff(removedAt, for: origin)

    let accepted = queue.enqueue(
      offer(issuedAt: issuedAt, expiresAt: issuedAt.addingTimeInterval(300)),
      now: removedAt.addingTimeInterval(1))
    #expect(!accepted)
    #expect(queue.offers.isEmpty)
  }

  @Test func delayedOlderOfferDoesNotSupersedeNewerOffer() {
    let now = Date(timeIntervalSince1970: 4_000)
    var queue = WatchPairingOfferQueue()
    let newer = offer(
      origin: URL(string: "https://newer.example")!, issuedAt: now,
      expiresAt: now.addingTimeInterval(300))
    let older = offer(
      issuedAt: now.addingTimeInterval(-10), expiresAt: now.addingTimeInterval(290))

    let acceptedNewer = queue.enqueue(newer, now: now)
    #expect(acceptedNewer)
    let accepted = queue.enqueue(older, now: now)
    #expect(!accepted)
    let pending = queue.next(now: now, phoneReachable: true)
    #expect(pending == newer)
  }

  @Test func olderFailureCannotClobberNewerRunAndCancelInvalidatesCurrentRun() {
    var gate = PairingRunGate()
    let first = gate.begin()
    let second = gate.begin()
    var visibleState = "B exchanging"

    if gate.accepts(first) { visibleState = "A failed" }
    #expect(visibleState == "B exchanging")
    if gate.accepts(second) { visibleState = "B paired" }
    #expect(visibleState == "B paired")

    gate.invalidate()
    if gate.accepts(second) { visibleState = "B failed" }
    #expect(visibleState == "B paired")
  }

  @MainActor @Test func replacementWhileBusyDrainsNewOfferAndSuppressesOldFailure() async {
    let now = Date(timeIntervalSince1970: 5_000)
    let first = offer(issuedAt: now, expiresAt: now.addingTimeInterval(300))
    let second = offer(
      origin: URL(string: "https://second.example")!, issuedAt: now.addingTimeInterval(1),
      expiresAt: now.addingTimeInterval(301))
    let processor = WatchPairingOfferProcessor()
    let attempts = PairingAttemptHarness()
    var pending: WatchPairingOffer? = first
    var notices: [String] = []

    let processing = Task { @MainActor in
      await processor.process(
        next: { pending }, attempt: attempts.attempt,
        remove: { id in if pending?.id == id { pending = nil } },
        shouldRetainAfterFailure: { _ in true },
        onPaired: { notices.append("paired \($0.label)") },
        onFailed: { offer, _ in notices.append("failed \(offer.label)") },
        onReadFailed: { _ in notices.append("read failed") })
    }
    await attempts.waitUntilStarted(1)
    pending = second
    #expect(processor.supersedeCurrent(with: second.id))
    let queued = await processor.process(
      next: { pending }, attempt: attempts.attempt,
      remove: { id in if pending?.id == id { pending = nil } },
      shouldRetainAfterFailure: { _ in true },
      onPaired: { notices.append("paired \($0.label)") },
      onFailed: { offer, _ in notices.append("failed \(offer.label)") },
      onReadFailed: { _ in notices.append("read failed") })
    #expect(queued == .queued)

    attempts.finish(1, with: .failure(PairingAttemptFailure.transport))
    await attempts.waitUntilStarted(2)
    attempts.finish(2, with: .success(()))
    #expect(await processing.value == .paired)
    #expect(attempts.offers == [first.id, second.id])
    #expect(notices == ["paired Test"])
  }

  @MainActor @Test func wakeupWhileBusyRetriesOnlyAfterCurrentAttemptSettles() async {
    let now = Date(timeIntervalSince1970: 6_000)
    let expected = offer(issuedAt: now, expiresAt: now.addingTimeInterval(300))
    let processor = WatchPairingOfferProcessor()
    let attempts = PairingAttemptHarness()
    var pending: WatchPairingOffer? = expected
    var paired = false

    let processing = Task { @MainActor in
      await processor.process(
        next: { pending }, attempt: attempts.attempt,
        remove: { id in if pending?.id == id { pending = nil } },
        shouldRetainAfterFailure: { _ in true }, onPaired: { _ in paired = true },
        onFailed: { _, _ in }, onReadFailed: { _ in })
    }
    await attempts.waitUntilStarted(1)
    _ = await processor.process(
      next: { pending }, attempt: attempts.attempt,
      remove: { id in if pending?.id == id { pending = nil } },
      shouldRetainAfterFailure: { _ in true }, onPaired: { _ in paired = true },
      onFailed: { _, _ in }, onReadFailed: { _ in })
    attempts.finish(1, with: .failure(PairingAttemptFailure.transport))
    await attempts.waitUntilStarted(2)
    #expect(attempts.offers == [expected.id, expected.id])
    attempts.finish(2, with: .success(()))

    #expect(await processing.value == .paired)
    #expect(paired)
  }

  @MainActor @Test func cancellationDuringExchangeSuppressesEveryOutcome() async {
    let now = Date(timeIntervalSince1970: 7_000)
    let expected = offer(issuedAt: now, expiresAt: now.addingTimeInterval(300))
    let processor = WatchPairingOfferProcessor()
    let attempts = PairingAttemptHarness()
    var pending: WatchPairingOffer? = expected
    var notices: [String] = []

    let processing = Task { @MainActor in
      await processor.process(
        next: { pending }, attempt: attempts.attempt, remove: { _ in pending = nil },
        shouldRetainAfterFailure: { _ in true },
        onPaired: { _ in notices.append("paired") },
        onFailed: { _, _ in notices.append("failed") },
        onReadFailed: { _ in notices.append("read failed") })
    }
    await attempts.waitUntilStarted(1)
    processor.cancel()
    pending = nil
    attempts.finish(1, with: .failure(PairingAttemptFailure.transport))

    #expect(await processing.value == .queued)
    #expect(notices.isEmpty)
  }
}
