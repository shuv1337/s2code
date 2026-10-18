import Foundation
import CryptoKit
import Observation
import T3WatchKit

enum Route: Hashable {
  /// `fetchedAt` is when `summary` was fetched, so the thread opens with its real age.
  case thread(WatchThreadSummary, fetchedAt: Date?)
  case compose(WatchThreadSummary)
  case receipt(commandId: String)
}

@MainActor @Observable
final class AppModel {
  private(set) var credentials: WatchCredentials?
  private(set) var client: WatchClient?
  private(set) var coordinator: SubmissionCoordinator?
  private(set) var capabilities: WatchCapabilities?
  private(set) var startupError: String?
  private(set) var authError: String?
  private(set) var pairing: PairingSession.State = .idle
  private(set) var pairingNotice: String?
  /// Per thread, bumped whenever one of its receipts commits, so the visible thread refetches.
  private(set) var commitEpochs: [String: Int] = [:]
  var path: [Route] = []
  private(set) var accounts = WatchEnvironmentAccounts()
  private(set) var pins = PinStore()
  var pairingMode: WatchConnectionMode = WatchConnectionMode(rawValue: UserDefaults.standard.string(forKey: "T3Watch.pairingMode") ?? "") ?? .automatic {
    didSet { UserDefaults.standard.set(pairingMode.rawValue, forKey: "T3Watch.pairingMode") }
  }
  var addingEnvironment = false
  var environmentLabel: String { accounts.selected?.label ?? "Environment" }
  private var generation = 0

  let store: SubmissionStore?
  private(set) var cache: SnapshotCache?
  private let pairingStore: PairingStore?
  private var pairingOfferStore: WatchPairingOfferStore?
  private let pairingOfferDirectory: URL?
  private let accountStore: any EnvironmentAccountStore
  private var pairingTask: Task<Void, Never>?
  private var pairingRuns = PairingRunGate()
  private let pairingOfferProcessor = WatchPairingOfferProcessor()

  init(credentialStore: any CredentialStore = KeychainCredentialStore(),
    accountStore: any EnvironmentAccountStore = KeychainEnvironmentAccountStore()) {
    self.accountStore = accountStore
    let directory: URL?
    do {
      directory = try WatchStorage.directory()
    } catch {
      directory = nil
      startupError = "Local storage unavailable: \(error.localizedDescription)"
    }
    pairingOfferDirectory = directory
    pairingOfferStore = nil
    if let directory {
      do {
        store = try SubmissionStore(directory: directory)
      } catch {
        store = nil
        startupError = "Local storage unavailable: \(error.localizedDescription)"
      }
      pairingStore = try? PairingStore(directory: directory)
    } else {
      store = nil
      cache = nil
      pairingStore = nil
    }
    do {
      accounts = try loadEnvironmentAccounts(from: accountStore, migrating: credentialStore)
      if let selected = accounts.selected { configure(selected) }
    } catch { startupError = "Could not load paired environments: \(error.localizedDescription)" }
    WatchConnectivityBridge.shared.activate(pairingReceiver: { [weak self] offer in
      guard let self else { throw CancellationError() }
      return try await self.receivePairingOffer(offer)
    }, availabilityReceiver: { [weak self] in
      await self?.processPendingPairingOffers()
    })
  }

  var isPaired: Bool { client != nil }

  /// Manual fallback: a `watch.…` credential printed by `pair --watch`.
  func pair(origin: String, credential: String) async throws {
    let url = try parseOrigin(origin)
    guard credential.trimmingCharacters(in: .whitespaces).hasPrefix("watch.") else {
      throw SetupError.invalidCredential
    }
    try await complete(
      origin: url, credential: credential, mode: pairingMode, runId: pairingRuns.current)
  }

  /// Device-code pairing: shows a code to approve on the environment, then exchanges the
  /// credential it receives exactly like `pair(origin:credential:)`.
  func startDevicePairing(origin: String) throws {
    let url = try parseOrigin(origin)
    run(PairingSession().applying(.start(origin: url), now: Date()))
  }

  func acceptPairingOffer(_ offer: WatchPairingOffer) async throws {
    pairingTask?.cancel()
    let runId = pairingRuns.begin()
    pairingMode = offer.mode
    setPairing(.exchanging(origin: offer.origin), runId: runId)
    do {
      try await complete(origin: offer.origin, credential: offer.credential, mode: offer.mode,
        runId: runId, label: offer.label)
      setPairing(.paired, runId: runId)
    } catch {
      setPairing(.failed(error.localizedDescription), runId: runId)
      throw error
    }
  }

  func receivePairingOffer(_ offer: WatchPairingOffer) async throws -> WatchPairingDelivery {
    let pairingOfferStore: WatchPairingOfferStore
    do {
      pairingOfferStore = try openPairingOfferStore()
    } catch {
      throw SetupError.pairingStorageUnavailable
    }
    guard try pairingOfferStore.enqueue(offer, now: Date()) else {
      throw SetupError.invalidPairingOffer
    }
    if pairingOfferProcessor.supersedeCurrent(with: offer.id) {
      pairingRuns.invalidate()
    }
    return await processPendingPairingOffers()
  }

  @discardableResult
  func processPendingPairingOffers() async -> WatchPairingDelivery {
    guard let pairingOfferStore = try? openPairingOfferStore() else { return .queued }
    return await pairingOfferProcessor.process(
      next: {
        try pairingOfferStore.next(
          now: Date(), phoneReachable: WatchConnectivityBridge.shared.isReachable)
      },
      attempt: { [weak self] offer in
        guard let self else { throw CancellationError() }
        try await self.acceptPairingOffer(offer)
      },
      remove: { try pairingOfferStore.remove($0) },
      shouldRetainAfterFailure: Self.shouldRetryPairingOffer,
      onPaired: { [weak self] offer in self?.pairingNotice = "Paired with \(offer.label)." },
      onFailed: { [weak self] offer, error in
        self?.pairingNotice = "Could not pair with \(offer.label): \(error.localizedDescription)"
      },
      onReadFailed: { [weak self] error in
        self?.pairingNotice = "Could not read pending pairing: \(error.localizedDescription)"
      })
  }

  func dismissPairingNotice() {
    pairingNotice = nil
  }

  /// Resumes polling a code persisted before the app was suspended or killed.
  func resumeDevicePairing() async {
    guard (!isPaired || addingEnvironment), !pairing.isActive, let pending = await pairingStore?.pending else { return }
    run(PairingSession(resuming: pending))
  }

  /// The cancelled runner forgets the code itself; the next `run` waits for it to finish.
  func cancelDevicePairing() {
    pairingTask?.cancel()
    if pairingOfferProcessor.isProcessing {
      pairingOfferProcessor.cancel()
      try? pairingOfferStore?.removeAll()
    }
    pairingRuns.invalidate()
    pairing = .idle
  }

  func selectEnvironment(_ id: String) throws {
    var next = accounts
    next.select(id)
    try accountStore.save(next)
    cancelDevicePairing()
    accounts = next
    if let selected = next.selected { configure(selected) }
  }

  func setConnectionMode(_ mode: WatchConnectionMode) throws {
    guard var selected = accounts.selected else { return }
    selected.mode = mode
    var next = accounts
    next.upsert(selected)
    try accountStore.save(next)
    accounts = next
    configure(selected)
  }

  func unpair() {
    var next = accounts
    let removed = next.selected
    if let id = next.selectedId { next.remove(id) }
    var cutoffStore: WatchPairingOfferStore?
    var previousCutoff: Date?
    do {
      if let removed {
        let pairingOfferStore = try openPairingOfferStore()
        cutoffStore = pairingOfferStore
        previousCutoff = pairingOfferStore.removalCutoff(for: removed.credentials.origin)
        try pairingOfferStore.setRemovalCutoff(Date(), for: removed.credentials.origin)
      }
      try accountStore.save(next)
    } catch {
      if let removed {
        try? cutoffStore?.setRemovalCutoff(previousCutoff, for: removed.credentials.origin)
      }
      startupError = "Could not remove environment: \(error.localizedDescription)"
      return
    }
    cancelDevicePairing()
    accounts = next
    generation += 1
    credentials = nil
    client = nil
    coordinator = nil
    capabilities = nil
    cache = nil
    authError = nil
    path = []
    if let selected = next.selected { configure(selected) }
  }

  /// Called on launch and resume: unresolved submissions survive suspension and app kills.
  func reconcile() async {
    guard let client else { return }
    let current = generation
    let coordinator = coordinator
    if capabilities == nil {
      let fetched = try? await client.capabilities()
      guard current == generation else { return }
      capabilities = fetched
      if let fetched, var selected = accounts.selected, selected.credentials.environmentId == nil {
        selected.credentials.environmentId = fetched.environmentId
        var next = accounts
        next.upsert(selected)
        do { try accountStore.save(next); accounts = next; configure(selected) }
        catch { startupError = error.localizedDescription }
        return
      }
    }
    await coordinator?.reconcileAll()
    try? await store?.prune(olderThan: 7 * 24 * 3600)
  }

  func handle(_ error: any Error) {
    if let error = error as? WatchClientError, error.isUnauthorized, error != .notConfigured {
      authError = "Credential rejected. Pair again."
    }
  }

  func noteCommitted(threadId: String) {
    commitEpochs[threadId, default: 0] += 1
  }

  private func run(_ session: PairingSession) {
    let previous = pairingTask
    previous?.cancel()
    let runId = pairingRuns.begin()
    pairing = session.state
    let mode = pairingMode
    let runner = PairingRunner(store: pairingStore, transport: WatchConnectivityBridge.shared.transport(mode: mode))
    pairingTask = Task { [weak self] in
      await previous?.value
      _ = await runner.run(
        session,
        exchange: { [weak self] origin, credential in
          guard let self else { throw CancellationError() }
          try await self.complete(origin: origin, credential: credential, mode: mode, runId: runId)
        },
        update: { [weak self] state in await self?.setPairing(state, runId: runId) })
      self?.finishPairing(runId: runId)
    }
  }

  private func setPairing(_ state: PairingSession.State, runId: Int) {
    guard pairingRuns.accepts(runId) else { return }
    pairing = state
  }

  private func finishPairing(runId: Int) {
    guard pairingRuns.accepts(runId) else { return }
    pairingTask = nil
  }

  /// Exchange, capabilities probe, then Keychain save. The credential is single-use, so a failure
  /// after the exchange means pairing again.
  private func complete(origin url: URL, credential: String, mode: WatchConnectionMode, runId: Int,
    label offeredLabel: String? = nil) async throws {
    let transport = WatchConnectivityBridge.shared.transport(mode: mode)
    var credentials = try await WatchClient.exchange(origin: url, credential: credential, transport: transport)
    let probe = WatchClient(baseURL: url, credentials: InMemoryCredentialStore(credentials), transport: transport)
    let capabilities = try await probe.capabilities()
    try Task.checkCancellation()
    guard pairingRuns.accepts(runId) else { throw CancellationError() }
    credentials.environmentId = capabilities.environmentId
    var next = accounts
    let label: String
    if let offeredLabel { label = offeredLabel }
    else if case .waitingForApproval(let pending, _) = pairing { label = pending.environment.label }
    else { label = url.host() ?? "Environment" }
    let account = WatchEnvironmentAccount(credentials: credentials, label: label, mode: mode)
    next.upsert(account)
    try accountStore.save(next)
    accounts = next
    configure(account)
    self.capabilities = capabilities
    addingEnvironment = false
  }

  private func parseOrigin(_ origin: String) throws -> URL {
    let trimmed = origin.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let url = URL(string: trimmed.contains("://") ? trimmed : "https://\(trimmed)"),
      url.host() != nil
    else { throw SetupError.invalidOrigin }
    return url
  }

  private func openPairingOfferStore() throws -> WatchPairingOfferStore {
    if let pairingOfferStore { return pairingOfferStore }
    guard let pairingOfferDirectory else { throw SetupError.pairingStorageUnavailable }
    let opened = try WatchPairingOfferStore(directory: pairingOfferDirectory)
    pairingOfferStore = opened
    return opened
  }

  private func configure(_ account: WatchEnvironmentAccount) {
    generation += 1
    self.credentials = account.credentials
    let client = WatchClient(baseURL: account.credentials.origin,
      credentials: InMemoryCredentialStore(account.credentials),
      transport: WatchConnectivityBridge.shared.transport(mode: account.mode))
    self.client = client
    coordinator = store.map { SubmissionCoordinator(store: $0, client: client) }
    let partition = SHA256.hash(data: Data(account.id.utf8)).map { String(format: "%02x", $0) }.joined()
    cache = try? SnapshotCache(directory: WatchStorage.directory(), fileName: "snapshots-\(partition).json")
    pins = PinStore(environment: partition)
    capabilities = nil
    authError = nil
    commitEpochs = [:]
    path = []
  }

  private static func shouldRetryPairingOffer(after error: any Error) -> Bool {
    guard let error = error as? WatchClientError else { return false }
    if case .transport = error { return true }
    return false
  }
}

enum SetupError: LocalizedError {
  case invalidOrigin, invalidCredential, invalidPairingOffer, pairingStorageUnavailable

  var errorDescription: String? {
    switch self {
    case .invalidOrigin: "Enter the environment URL, e.g. https://host:13773."
    case .invalidCredential: "Paste the credential from `pair --watch`; it starts with \"watch.\"."
    case .invalidPairingOffer: "This phone pairing offer is expired or was removed."
    case .pairingStorageUnavailable: "Pending phone pairing could not be stored."
    }
  }
}

/// Local navigation preference only; never an authorization rule. Order is the pin order.
@MainActor @Observable
final class PinStore {
  private let key: String
  private(set) var ids: [String]

  init(environment: String = "unpaired") {
    key = "T3Watch.pinnedThreadIds.\(environment)"
    if let scoped = UserDefaults.standard.stringArray(forKey: key) { ids = scoped }
    else if environment != "unpaired", let legacy = UserDefaults.standard.stringArray(forKey: "T3Watch.pinnedThreadIds") {
      ids = legacy
      UserDefaults.standard.set(legacy, forKey: key)
      UserDefaults.standard.removeObject(forKey: "T3Watch.pinnedThreadIds")
    } else { ids = [] }
  }

  func contains(_ id: String) -> Bool { ids.contains(id) }

  func toggle(_ id: String) {
    if let index = ids.firstIndex(of: id) { ids.remove(at: index) } else { ids.append(id) }
    UserDefaults.standard.set(ids, forKey: key)
  }
}
