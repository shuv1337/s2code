import Foundation
import Observation
import T3WatchKit

/// One paired server's last fetched page. Each server refreshes independently, so an offline one
/// shows its last known state without holding up the others.
struct ServerFeed {
  /// Replaced feeds and newer fetches both leave a result that no longer matches.
  var generation: Int
  var attempt: Int = 0
  var client: WatchClient
  var threads: [WatchThreadSummary] = []
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

  private let accountStore: any EnvironmentAccountStore
  private var pairingTask: Task<Void, Never>?
  private var pairingGeneration = 0
  private var feedGeneration = 0
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
      // See SetupView: `-S2CodeTVPairOrigin` pairs that origin when it is not paired yet.
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

  // MARK: Pairing

  /// Shows a code on the TV to approve on the server with `s2code pair --watch --approve CODE`.
  func startPairing(origin: String) throws {
    let url = try Self.parseOrigin(origin)
    pairingGeneration += 1
    let generation = pairingGeneration
    pairingTask?.cancel()
    let previous = pairingTask
    pairingLabel = nil
    let session = PairingSession().applying(.start(origin: url), now: Date())
    pairing = session.state
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
    pairingTask = nil
    pairing = .idle
    pairingLabel = nil
  }

  #if DEBUG
    /// Launch argument `-S2CodeTVPairOrigin`. Once per process, and only if that origin is not paired.
    func consumeLaunchPairOrigin() {
      guard !didConsumeLaunchPairOrigin else { return }
      didConsumeLaunchPairOrigin = true
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
    if case .waitingForApproval(let pending, _) = state { pairingLabel = pending.environment.label }
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
  func forget(_ id: String) {
    var next = accounts
    next.remove(id)
    do {
      try accountStore.save(next)
    } catch {
      startupError = "Could not forget the server: \(error.localizedDescription)"
      return
    }
    accounts = next
    feeds[id] = nil
    if accounts.accounts.isEmpty { cancelPairing() }
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

  func refresh(_ id: String) async {
    guard var current = feeds[id], !current.authRejected else { return }
    let generation = current.generation
    current.attempt += 1
    let attempt = current.attempt
    let client = current.client
    feeds[id] = current
    let page: WatchThreadPage
    do throws(WatchClientError) {
      page = try await client.threads(limit: WatchLimits.maxThreadPageSize)
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
    feeds[id]?.threads = page.items
    feeds[id]?.fetchedAt = Date()
    feeds[id]?.refreshError = nil
    feeds[id]?.unreachable = false
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
