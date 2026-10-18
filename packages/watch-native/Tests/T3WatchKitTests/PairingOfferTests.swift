import Foundation
import Testing

@testable import T3WatchKit

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
    let store = try WatchPairingOfferStore(directory: directory)

    #expect(try store.enqueue(expected, now: now))
    #expect(try store.next(now: now, phoneReachable: false) == nil)

    let restored = try WatchPairingOfferStore(directory: directory)
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
    let store = try WatchPairingOfferStore(directory: directory)
    let expired = offer(
      issuedAt: now.addingTimeInterval(-301), expiresAt: now.addingTimeInterval(-1))

    let accepted = try store.enqueue(expired, now: now)
    #expect(!accepted)
    #expect(try store.next(now: now, phoneReachable: true) == nil)
    #expect(try WatchPairingOfferStore(directory: directory)
      .next(now: now, phoneReachable: true) == nil)
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
}
