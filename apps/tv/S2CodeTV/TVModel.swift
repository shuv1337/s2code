import Foundation
import Observation
import os
import T3WatchKit

private let pairingLog = Logger(subsystem: "dev.shuv.s2code.tv", category: "pairing")

/// One paired server's last fetched page. Each server refreshes independently, so an offline one
/// shows its last known state without holding up the others.
struct ServerFeed {
  /// Replaced feeds and newer fetches both leave a result that no longer matches.
  var generation: Int
  var attempt: Int = 0
  var client: WatchClient
  var threads: [WatchThreadSummary] = []
  /// Set when another page exists, so the shelf does not look complete.
  var nextCursor: String?
  /// Pages kept across polls. More raises this; a short tail lowers it.
  var pageCount = 1
  /// Last time pages after the first were fetched. The 5s poll does not refresh them.
  var deepFetchedAt: Date?
  var fetchedAt: Date?
  var refreshError: String?
  /// Transport failure only. HTTP, decode, and environment errors keep `refreshError` instead.
  var unreachable = false
  var authRejected = false
}

/// Thread IDs are environment-local, so a thread is addressed by its server too.
struct ThreadRef: Hashable {
  var serverId: String
  var threadId: String
}

/// Result of `GET /threads/:id`. That response is still the 280-character excerpt.
enum ThreadDetailLoad {
  case current(WatchThreadSummary)
  case gone
  case unavailable
}

/// Read-only viewer for paired environments. It reuses the Watch HTTP API and pairing, and never
/// submits commands.
@MainActor @Observable
final class TVModel {
  private(set) var accounts = WatchEnvironmentAccounts()
  private(set) var feeds: [String: ServerFeed] = [:]
  private(set) var startupError: String?
  private(set) var pairing: PairingSession.State = .idle
  /// Shows setup over the dashboard while another server is paired.
  var addingServer = false
  /// Captured while waiting: the runner has moved to `.exchanging` by the time the exchange runs.
  private var pairingLabel: String?

  /// The Watch API is request/response only, so the dashboard polls while it is on screen.
  static let refreshInterval: Duration = .seconds(5)
  /// Pages after the first change slowly. Refetching them on the 5s poll would restamp every card.
  static let deepRefreshInterval: TimeInterval = 30
  /// More walks forward. Stop at four pages (200 threads).
  static let maxShelfPages = 4

  private let accountStore: any EnvironmentAccountStore
  /// tvOS purges application-support files. This code has to survive that, and it is tiny.
  private let pendingCodes = PendingPairingStore()
  private var savedPending: PairingSession.Pending?
  private var pairingTask: Task<Void, Never>?
  private var pairingGeneration = 0
  private var feedGeneration = 0
  private(set) var pairingPersistError: String?
  #if DEBUG
    private var didConsumeLaunchPairOrigin = false
  #endif

  init(accountStore: any EnvironmentAccountStore = KeychainEnvironmentAccountStore()) {
    self.accountStore = accountStore
    do {
      accounts = try accountStore.load() ?? WatchEnvironmentAccounts()
    } catch {
      startupError = "Could not load paired servers: \(error.localizedDescription)"
    }
    for account in accounts.accounts { feeds[account.id] = feed(for: account) }
    #if DEBUG
      // `-S2CodeTVPairOrigin` opens setup when that origin is not paired yet.
      if let origin = UserDefaults.standard.string(forKey: "S2CodeTVPairOrigin"),
        let url = try? Self.parseOrigin(origin),
        !accounts.accounts.contains(where: { $0.credentials.origin == url })
      {
        addingServer = true
      }
    #endif
  }

  var servers: [WatchEnvironmentAccount] { accounts.accounts }

  func thread(_ ref: ThreadRef) -> WatchThreadSummary? {
    feeds[ref.serverId]?.threads.first { $0.threadId == ref.threadId }
  }

  /// The open thread's own fetch. A row that leaves the loaded page would otherwise freeze
  /// on the last list excerpt. A transport failure leaves the screen unchanged.
  func loadThread(_ ref: ThreadRef) async -> ThreadDetailLoad {
    guard let feed = feeds[ref.serverId], !feed.authRejected else { return .unavailable }
    let generation = feed.generation
    let client = feed.client
    do throws(WatchClientError) {
      let thread = try await client.thread(id: ref.threadId)
      guard feeds[ref.serverId]?.generation == generation, !Task.isCancelled else { return .unavailable }
      return .current(thread)
    } catch {
      guard feeds[ref.serverId]?.generation == generation, !Task.isCancelled else { return .unavailable }
      if case .request(let code, _) = error, code == .threadNotFound { return .gone }
      return .unavailable
    }
  }

  // MARK: Pairing

  /// Shows a code on the TV to approve on the server with `s2code pair --watch --approve CODE`.
  func startPairing(origin: String) throws {
    let url = try Self.parseOrigin(origin)
    begin(PairingSession().applying(.start(origin: url), now: Date()))
  }

  /// A relaunch while the code is on screen keeps polling it. The bootstrap credential is
  /// single-use, so a kill after approval learns from the server that it was consumed.
  func resumePairing() async {
    guard !pairing.isActive else { return }
    let pending: PairingSession.Pending
    do {
      guard let stored = try pendingCodes.load() else { return }
      pending = stored
    } catch {
      reportPairingStoreFailure(error)
      return
    }
    savedPending = pending
    addingServer = true
    begin(PairingSession(resuming: pending))
  }

  private func begin(_ session: PairingSession) {
    pairingGeneration += 1
    let generation = pairingGeneration
    pairingTask?.cancel()
    let previous = pairingTask
    pairingLabel = nil
    if case .waitingForApproval(let pending, _) = session.state {
      pairingLabel = pending.environment.label
    }
    pairing = session.state
    // No file store: its cancellation clears whatever is on disk, including a newer code.
    let runner = PairingRunner(store: nil, clientLabel: "S2Code Apple TV")
    pairingTask = Task { [weak self] in
      await previous?.value
      guard let self, generation == self.pairingGeneration else { return }
      _ = await runner.run(
        session,
        exchange: { [weak self] origin, credential in
          guard let self else { throw CancellationError() }
          try await self.completePairing(
            origin: origin, credential: credential, generation: generation)
        },
        update: { [weak self] state in await self?.setPairing(state, generation: generation) })
    }
  }

  func cancelPairing() {
    pairingGeneration += 1
    pairingTask?.cancel()
    // Keep the task. The next begin() waits for this cancellation; dropping the handle let
    // it finish later and erase a code the new attempt had already saved.
    pairing = .idle
    pairingLabel = nil
    clearStoredPairing()
  }

  #if DEBUG
    /// Launch argument `-S2CodeTVPairOrigin`. Once per process, and only if that origin is not paired.
    /// Skips a code already resumed from disk, so the launch argument does not replace it.
    func consumeLaunchPairOrigin() {
      guard !didConsumeLaunchPairOrigin else { return }
      didConsumeLaunchPairOrigin = true
      guard !pairing.isActive else { return }
      guard let origin = UserDefaults.standard.string(forKey: "S2CodeTVPairOrigin"),
        let url = try? Self.parseOrigin(origin),
        !accounts.accounts.contains(where: { $0.credentials.origin == url })
      else { return }
      try? startPairing(origin: origin)
    }
  #endif

  private func setPairing(_ state: PairingSession.State, generation: Int) {
    guard generation == pairingGeneration, !Task.isCancelled else { return }
    pairing = state
    switch state {
    case .waitingForApproval(let pending, _):
      pairingLabel = pending.environment.label
      storePending(pending)
    case .idle, .paired, .denied, .expired, .failed:
      clearStoredPairing()
    case .starting, .approved, .exchanging:
      break
    }
  }

  private func storePending(_ pending: PairingSession.Pending) {
    guard pending != savedPending else { return }
    do {
      try pendingCodes.save(pending)
      savedPending = pending
      pairingPersistError = nil
    } catch {
      reportPairingStoreFailure(error)
    }
  }

  /// Deletes only the code this attempt stored. A newer code under the same key is left alone.
  private func clearStoredPairing() {
    guard let saved = savedPending else { return }
    do {
      try pendingCodes.clear(matching: saved.deviceCode)
      savedPending = nil
    } catch {
      reportPairingStoreFailure(error)
    }
  }

  private func reportPairingStoreFailure(_ error: Error) {
    pairingLog.error("Pending pairing store failed: \(error.localizedDescription, privacy: .public)")
    pairingPersistError = error.localizedDescription
  }

  /// The bootstrap credential is single-use: a failure after the exchange means pairing again.
  private func completePairing(origin: URL, credential: String, generation: Int) async throws {
    func stillCurrent() -> Bool { generation == pairingGeneration && !Task.isCancelled }
    guard stillCurrent() else { throw CancellationError() }
    var credentials = try await WatchClient.exchange(
      origin: origin, credential: credential, clientLabel: "S2Code Apple TV", deviceType: "unknown")
    guard stillCurrent() else { throw CancellationError() }
    let probe = WatchClient(baseURL: origin, credentials: InMemoryCredentialStore(credentials))
    let capabilities = try await probe.capabilities()
    guard stillCurrent() else { throw CancellationError() }
    credentials.environmentId = capabilities.environmentId
    let label = pairingLabel ?? origin.host() ?? "Server"
    let account = WatchEnvironmentAccount(credentials: credentials, label: label, mode: .direct)
    var next = accounts
    let replaced = next.accounts.filter {
      $0.id == account.id || $0.credentials.origin == account.credentials.origin
    }
    next.upsert(account)
    try accountStore.save(next)
    accounts = next
    for old in replaced { feeds[old.id] = nil }
    feeds[account.id] = feed(for: account)
    addingServer = false
    await refresh(account.id)
  }

  /// Forgets a server on this TV. Its session stays valid on the server until revoked there.
  /// Returns the keychain error and leaves the server in place when the save fails.
  func forget(_ id: String) -> String? {
    var next = accounts
    next.remove(id)
    do {
      try accountStore.save(next)
    } catch {
      return "Could not forget the server: \(error.localizedDescription)"
    }
    accounts = next
    feeds[id] = nil
    if accounts.accounts.isEmpty { cancelPairing() }
    return nil
  }

  // MARK: Refresh

  /// Each server sleeps on its own clock. One 15s timeout must not stall the others past the
  /// 15s stale threshold.
  func refreshLoop() async {
    await withTaskGroup(of: Void.self) { group in
      for id in feeds.keys {
        group.addTask { [weak self] in await self?.refreshContinuously(id) }
      }
    }
  }

  private func refreshContinuously(_ id: String) async {
    while !Task.isCancelled {
      guard let feed = feeds[id], !feed.authRejected else { return }
      await refresh(id)
      if Task.isCancelled || feeds[id] == nil || feeds[id]?.authRejected == true { return }
      try? await Task.sleep(for: Self.refreshInterval)
    }
  }

  func refresh(_ id: String, deep: Bool = false) async {
    guard var current = feeds[id], !current.authRejected else { return }
    let generation = current.generation
    current.attempt += 1
    let attempt = current.attempt
    let keptPageCount = min(max(current.pageCount, 1), Self.maxShelfPages)
    let deepDue = current.deepFetchedAt.map {
      Date().timeIntervalSince($0) >= Self.deepRefreshInterval
    } ?? (keptPageCount > 1)
    let pages = (deep || deepDue) ? keptPageCount : 1
    let client = current.client
    let previousThreads = current.threads
    let previousCursor = current.nextCursor
    feeds[id] = current
    var items: [WatchThreadSummary] = []
    var seen = Set<String>()
    var cursor: String?
    var fetched = 0
    do throws(WatchClientError) {
      while fetched < pages {
        let page = try await client.threads(cursor: cursor, limit: WatchLimits.maxThreadPageSize)
        guard isCurrent(id, generation: generation, attempt: attempt) else { return }
        fetched += 1
        for thread in page.items where seen.insert(thread.threadId).inserted {
          items.append(thread)
        }
        cursor = page.nextCursor
        if cursor == nil { break }
      }
    } catch {
      guard isCurrent(id, generation: generation, attempt: attempt) else { return }
      if isCancelledRequest(error) { return }
      if error.isUnauthorized {
        feeds[id]?.authRejected = true
        feeds[id]?.unreachable = false
      } else {
        feeds[id]?.unreachable = isUnreachable(error)
      }
      feeds[id]?.refreshError = error.localizedDescription
      return
    }
    guard isCurrent(id, generation: generation, attempt: attempt) else { return }
    // A 5s poll rewrites page 1 only. Deeper cards stay until the slow pass, unless the
    // server now fits on the first page.
    if pages > 1 || cursor == nil || keptPageCount <= 1 {
      feeds[id]?.threads = items
      feeds[id]?.nextCursor = cursor
      feeds[id]?.pageCount = max(fetched, 1)
      if pages > 1 { feeds[id]?.deepFetchedAt = Date() }
    } else {
      let extra = previousThreads.filter { !seen.contains($0.threadId) }
      feeds[id]?.threads = items + extra
      feeds[id]?.nextCursor = previousCursor
    }
    feeds[id]?.fetchedAt = Date()
    feeds[id]?.refreshError = nil
    feeds[id]?.unreachable = false
  }

  /// Asks the next refresh to keep one more page, and fetches that page now.
  func loadMore(_ id: String) async {
    guard var current = feeds[id], current.nextCursor != nil, !current.authRejected,
      current.pageCount < Self.maxShelfPages
    else { return }
    current.pageCount += 1
    feeds[id] = current
    await refresh(id, deep: true)
  }

  private func isCurrent(_ id: String, generation: Int, attempt: Int) -> Bool {
    guard let feed = feeds[id] else { return false }
    return feed.generation == generation && feed.attempt == attempt && !Task.isCancelled
  }

  private func isCancelledRequest(_ error: WatchClientError) -> Bool {
    if case .transport(let code, _) = error { return code == URLError.Code.cancelled.rawValue }
    return false
  }

  /// Timeouts and connection failures only. A 403, 500, decode error, or environment mismatch
  /// is the server answering, so the dashboard shows that message.
  private func isUnreachable(_ error: WatchClientError) -> Bool {
    if case .transport = error { return !isCancelledRequest(error) }
    return false
  }

  private func feed(for account: WatchEnvironmentAccount) -> ServerFeed {
    feedGeneration += 1
    return ServerFeed(
      generation: feedGeneration,
      client: WatchClient(
        baseURL: account.credentials.origin,
        credentials: InMemoryCredentialStore(account.credentials)))
  }

  static func parseOrigin(_ origin: String) throws -> URL {
    let trimmed = origin.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let url = URL(string: trimmed.contains("://") ? trimmed : "http://\(trimmed)"),
      url.host() != nil
    else { throw OriginError() }
    return url
  }
}

struct OriginError: LocalizedError {
  var errorDescription: String? { "Enter the server URL, for example http://host:13773." }
}

/// In-progress device code. UserDefaults is one of the few stores tvOS does not purge.
struct PendingPairingStore {
  static let key = "S2CodeTV.pendingPairing"
  var defaults: UserDefaults = .standard

  func load() throws -> PairingSession.Pending? {
    guard let data = defaults.data(forKey: Self.key) else { return nil }
    do {
      return try JSONDecoder.watch.decode(PairingSession.Pending.self, from: data)
    } catch {
      defaults.removeObject(forKey: Self.key)
      throw error
    }
  }

  func save(_ pending: PairingSession.Pending) throws {
    let data = try JSONEncoder.watch.encode(pending)
    defaults.set(data, forKey: Self.key)
    guard defaults.data(forKey: Self.key) == data else { throw PendingPairingError.notSaved }
  }

  /// Removes `deviceCode` only. A code saved by a later attempt stays put.
  func clear(matching deviceCode: String) throws {
    guard let stored = try load() else { return }
    guard stored.deviceCode == deviceCode else { return }
    defaults.removeObject(forKey: Self.key)
    if defaults.data(forKey: Self.key) != nil { throw PendingPairingError.notCleared }
  }
}

struct PendingPairingError: LocalizedError {
  static let notSaved = PendingPairingError("The pairing code could not be saved on this Apple TV.")
  static let notCleared = PendingPairingError("The pairing code could not be removed on this Apple TV.")

  var errorDescription: String?
  init(_ errorDescription: String) { self.errorDescription = errorDescription }
}
