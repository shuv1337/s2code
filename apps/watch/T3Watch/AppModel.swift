import Foundation
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
  /// Per thread, bumped whenever one of its receipts commits, so the visible thread refetches.
  private(set) var commitEpochs: [String: Int] = [:]
  var path: [Route] = []
  let pins = PinStore()

  let store: SubmissionStore?
  let cache: SnapshotCache?
  private let pairingStore: PairingStore?
  private let credentialStore: any CredentialStore
  private var pairingTask: Task<Void, Never>?
  private var pairingRun = 0

  init(credentialStore: any CredentialStore = KeychainCredentialStore()) {
    self.credentialStore = credentialStore
    do {
      let directory = try WatchStorage.directory()
      store = try SubmissionStore(directory: directory)
      cache = try? SnapshotCache(directory: directory)
      pairingStore = try? PairingStore(directory: directory)
    } catch {
      store = nil
      cache = nil
      pairingStore = nil
      startupError = "Local storage unavailable: \(error.localizedDescription)"
    }
    if let saved = try? credentialStore.load() { configure(saved) }
  }

  var isPaired: Bool { client != nil }

  /// Manual fallback: a `watch.…` credential printed by `pair --watch`.
  func pair(origin: String, credential: String) async throws {
    let url = try parseOrigin(origin)
    guard credential.trimmingCharacters(in: .whitespaces).hasPrefix("watch.") else {
      throw SetupError.invalidCredential
    }
    try await complete(origin: url, credential: credential)
  }

  /// Device-code pairing: shows a code to approve on the environment, then exchanges the
  /// credential it receives exactly like `pair(origin:credential:)`.
  func startDevicePairing(origin: String) throws {
    let url = try parseOrigin(origin)
    run(PairingSession().applying(.start(origin: url), now: Date()))
  }

  /// Resumes polling a code persisted before the app was suspended or killed.
  func resumeDevicePairing() async {
    guard !isPaired, !pairing.isActive, let pending = await pairingStore?.pending else { return }
    run(PairingSession(resuming: pending))
  }

  /// The cancelled runner forgets the code itself; the next `run` waits for it to finish.
  func cancelDevicePairing() {
    pairingTask?.cancel()
    pairingRun += 1
    pairing = .idle
  }

  func unpair() {
    try? credentialStore.clear()
    Task { [cache] in try? await cache?.clear() }
    credentials = nil
    client = nil
    coordinator = nil
    capabilities = nil
    authError = nil
    pairing = .idle
    path = []
  }

  /// Called on launch and resume: unresolved submissions survive suspension and app kills.
  func reconcile() async {
    guard let client else { return }
    if capabilities == nil { capabilities = try? await client.capabilities() }
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
    pairingRun += 1
    let runId = pairingRun
    pairing = session.state
    let runner = PairingRunner(store: pairingStore)
    pairingTask = Task { [weak self] in
      await previous?.value
      _ = await runner.run(
        session,
        exchange: { [weak self] origin, credential in
          guard let self else { throw CancellationError() }
          try await self.complete(origin: origin, credential: credential)
        },
        update: { [weak self] state in await self?.setPairing(state, runId: runId) })
      self?.finishPairing(runId: runId)
    }
  }

  private func setPairing(_ state: PairingSession.State, runId: Int) {
    guard runId == pairingRun else { return }
    pairing = state
  }

  private func finishPairing(runId: Int) {
    guard runId == pairingRun else { return }
    pairingTask = nil
  }

  /// Exchange, capabilities probe, then Keychain save. The credential is single-use, so a failure
  /// after the exchange means pairing again.
  private func complete(origin url: URL, credential: String) async throws {
    var credentials = try await WatchClient.exchange(origin: url, credential: credential)
    let probe = WatchClient(baseURL: url, credentials: InMemoryCredentialStore(credentials))
    let capabilities = try await probe.capabilities()
    credentials.environmentId = capabilities.environmentId
    try credentialStore.save(credentials)
    try? await cache?.clear()
    configure(credentials)
    self.capabilities = capabilities
    authError = nil
  }

  private func parseOrigin(_ origin: String) throws -> URL {
    let trimmed = origin.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let url = URL(string: trimmed.contains("://") ? trimmed : "https://\(trimmed)"),
      url.host() != nil
    else { throw SetupError.invalidOrigin }
    return url
  }

  private func configure(_ credentials: WatchCredentials) {
    self.credentials = credentials
    let client = WatchClient(baseURL: credentials.origin, credentials: credentialStore)
    self.client = client
    coordinator = store.map { SubmissionCoordinator(store: $0, client: client) }
  }
}

enum SetupError: LocalizedError {
  case invalidOrigin, invalidCredential

  var errorDescription: String? {
    switch self {
    case .invalidOrigin: "Enter the environment URL, e.g. https://host:13773."
    case .invalidCredential: "Paste the credential from `pair --watch`; it starts with \"watch.\"."
    }
  }
}

/// Local navigation preference only; never an authorization rule. Order is the pin order.
@MainActor @Observable
final class PinStore {
  private static let key = "T3Watch.pinnedThreadIds"
  private(set) var ids: [String]

  init() {
    ids = UserDefaults.standard.stringArray(forKey: Self.key) ?? []
  }

  func contains(_ id: String) -> Bool { ids.contains(id) }

  func toggle(_ id: String) {
    if let index = ids.firstIndex(of: id) { ids.remove(at: index) } else { ids.append(id) }
    UserDefaults.standard.set(ids, forKey: Self.key)
  }
}
