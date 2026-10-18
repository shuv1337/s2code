import Foundation
import Synchronization

public struct WatchPairingOffer: Codable, Hashable, Sendable, Identifiable {
  public var id: UUID
  public var origin: URL
  public var credential: String
  public var mode: WatchConnectionMode
  public var label: String
  public var issuedAt: Date
  public var expiresAt: Date

  public init(id: UUID, origin: URL, credential: String, mode: WatchConnectionMode, label: String,
    issuedAt: Date, expiresAt: Date) {
    self.id = id
    self.origin = origin
    self.credential = credential
    self.mode = mode
    self.label = label
    self.issuedAt = issuedAt
    self.expiresAt = expiresAt
  }
}

public enum WatchPairingDelivery: String, Codable, Sendable {
  case paired, queued
}

public struct WatchPairingOfferQueue: Codable, Hashable, Sendable {
  public private(set) var offers: [WatchPairingOffer]
  public private(set) var removalCutoffs: [String: Date]

  public init(offers: [WatchPairingOffer] = [], removalCutoffs: [String: Date] = [:]) {
    self.offers = offers
    self.removalCutoffs = removalCutoffs
  }

  public mutating func enqueue(_ offer: WatchPairingOffer, now: Date) -> Bool {
    prune(now: now)
    let originKey = Self.originKey(offer.origin)
    guard offer.issuedAt <= offer.expiresAt, offer.expiresAt > now,
      removalCutoffs[originKey].map({ offer.issuedAt > $0 }) ?? true,
      offers.max(by: { $0.issuedAt < $1.issuedAt })
        .map({ offer.issuedAt >= $0.issuedAt }) ?? true
    else { return false }
    offers.removeAll()
    offers.append(offer)
    return true
  }

  public mutating func next(now: Date, phoneReachable: Bool) -> WatchPairingOffer? {
    prune(now: now)
    return offers
      .filter { $0.mode != .phone || phoneReachable }
      .max { $0.issuedAt < $1.issuedAt }
  }

  public mutating func remove(_ id: UUID) {
    offers.removeAll { $0.id == id }
  }

  public mutating func removeAll() {
    offers.removeAll()
  }

  public mutating func setRemovalCutoff(_ cutoff: Date?, for origin: URL) {
    removalCutoffs[Self.originKey(origin)] = cutoff
  }

  public func removalCutoff(for origin: URL) -> Date? {
    removalCutoffs[Self.originKey(origin)]
  }

  public mutating func prune(now: Date) {
    offers.removeAll { offer in
      offer.expiresAt <= now ||
        removalCutoffs[Self.originKey(offer.origin)].map({ offer.issuedAt <= $0 }) == true
    }
  }

  private static func originKey(_ origin: URL) -> String {
    var value = origin.absoluteString
    while value.hasSuffix("/") { value.removeLast() }
    return value.lowercased()
  }
}

public final class WatchPairingOfferStore: Sendable {
  public nonisolated let fileURL: URL
  private let state: Mutex<WatchPairingOfferQueue>

  public init(
    directory: URL, fileName: String = "watch-pairing-offers.json", now: Date = Date()
  ) throws {
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    fileURL = directory.appendingPathComponent(fileName)
    let saved = (try? Data(contentsOf: fileURL)).flatMap {
      try? JSONDecoder.watch.decode(WatchPairingOfferQueue.self, from: $0)
    }
    var restored = saved ?? WatchPairingOfferQueue()
    restored.prune(now: now)
    state = Mutex(restored)
    if FileManager.default.fileExists(atPath: fileURL.path) {
      try Self.persist(restored, to: fileURL)
    }
  }

  @discardableResult
  public func enqueue(_ offer: WatchPairingOffer, now: Date) throws -> Bool {
    try update { $0.enqueue(offer, now: now) }
  }

  public func next(now: Date, phoneReachable: Bool) throws -> WatchPairingOffer? {
    try update { $0.next(now: now, phoneReachable: phoneReachable) }
  }

  public func remove(_ id: UUID) throws {
    try update { $0.remove(id) }
  }

  public func removeAll() throws {
    try update { $0.removeAll() }
  }

  public func removalCutoff(for origin: URL) -> Date? {
    state.withLock { $0.removalCutoff(for: origin) }
  }

  public func setRemovalCutoff(_ cutoff: Date?, for origin: URL) throws {
    try update { $0.setRemovalCutoff(cutoff, for: origin) }
  }

  private func update<T>(_ body: (inout WatchPairingOfferQueue) -> T) throws -> T {
    try state.withLock { state in
      let result = body(&state)
      try Self.persist(state, to: fileURL)
      return result
    }
  }

  private static func persist(_ state: WatchPairingOfferQueue, to fileURL: URL) throws {
    try JSONEncoder.watch.encode(state).write(
      to: fileURL, options: [.atomic, .completeFileProtection])
    var protectedURL = fileURL
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try protectedURL.setResourceValues(values)
  }
}

public struct PairingRunGate: Sendable {
  public private(set) var current = 0

  public init() {}

  public mutating func begin() -> Int {
    current += 1
    return current
  }

  public mutating func invalidate() {
    current += 1
  }

  public func accepts(_ runId: Int) -> Bool {
    runId == current
  }
}

/// Serializes offer attempts while preserving one wakeup that arrives during an in-flight attempt.
/// A replacement or cancellation invalidates every outcome from the superseded attempt.
@MainActor
public final class WatchPairingOfferProcessor {
  public private(set) var currentOfferID: UUID?
  public private(set) var isProcessing = false
  private var pendingDrain = false
  private var generation = 0

  public init() {}

  public func supersedeCurrent(with offerID: UUID) -> Bool {
    guard let currentOfferID, currentOfferID != offerID else { return false }
    generation += 1
    self.currentOfferID = nil
    return true
  }

  public func cancel() {
    generation += 1
    currentOfferID = nil
    pendingDrain = false
  }

  @discardableResult
  public func process(
    next: () throws -> WatchPairingOffer?,
    attempt: (WatchPairingOffer) async throws -> Void,
    remove: (UUID) throws -> Void,
    shouldRetainAfterFailure: (any Error) -> Bool,
    onPaired: (WatchPairingOffer) -> Void,
    onFailed: (WatchPairingOffer, any Error) -> Void,
    onReadFailed: (any Error) -> Void
  ) async -> WatchPairingDelivery {
    guard !isProcessing else {
      pendingDrain = true
      return .queued
    }
    isProcessing = true
    defer {
      isProcessing = false
      currentOfferID = nil
    }

    var delivery = WatchPairingDelivery.queued
    repeat {
      pendingDrain = false
      let offer: WatchPairingOffer
      do {
        guard let pending = try next() else { return delivery }
        offer = pending
      } catch {
        onReadFailed(error)
        return delivery
      }

      currentOfferID = offer.id
      let attemptGeneration = generation
      do {
        try await attempt(offer)
      } catch {
        guard accepts(offer.id, generation: attemptGeneration) else { continue }
        onFailed(offer, error)
        if !shouldRetainAfterFailure(error) { try? remove(offer.id) }
        currentOfferID = nil
        continue
      }

      guard accepts(offer.id, generation: attemptGeneration) else { continue }
      do {
        try remove(offer.id)
      } catch {
        guard accepts(offer.id, generation: attemptGeneration) else { continue }
        onFailed(offer, error)
        currentOfferID = nil
        continue
      }
      guard accepts(offer.id, generation: attemptGeneration) else { continue }
      onPaired(offer)
      delivery = .paired
      currentOfferID = nil
    } while pendingDrain

    return delivery
  }

  private func accepts(_ offerID: UUID, generation: Int) -> Bool {
    self.generation == generation && currentOfferID == offerID
  }
}
