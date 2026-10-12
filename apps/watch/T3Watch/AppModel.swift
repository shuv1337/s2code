import Foundation
import Observation
import T3WatchKit

enum Route: Hashable {
  case thread(WatchThreadSummary)
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
  var path: [Route] = []
  let pins = PinStore()

  let store: SubmissionStore?
  private let credentialStore: any CredentialStore

  init(credentialStore: any CredentialStore = KeychainCredentialStore()) {
    self.credentialStore = credentialStore
    do {
      store = try SubmissionStore.applicationSupport()
    } catch {
      store = nil
      startupError = "Local storage unavailable: \(error.localizedDescription)"
    }
    if let saved = try? credentialStore.load() { configure(saved) }
  }

  var isPaired: Bool { client != nil }

  func pair(origin: String, credential: String) async throws {
    let trimmed = origin.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let url = URL(string: trimmed.contains("://") ? trimmed : "https://\(trimmed)"),
      url.host() != nil
    else { throw SetupError.invalidOrigin }
    guard credential.trimmingCharacters(in: .whitespaces).hasPrefix("watch.") else {
      throw SetupError.invalidCredential
    }
    var credentials = try await WatchClient.exchange(origin: url, credential: credential)
    let probe = WatchClient(baseURL: url, credentials: InMemoryCredentialStore(credentials))
    let capabilities = try await probe.capabilities()
    credentials.environmentId = capabilities.environmentId
    try credentialStore.save(credentials)
    configure(credentials)
    self.capabilities = capabilities
    authError = nil
  }

  func unpair() {
    try? credentialStore.clear()
    credentials = nil
    client = nil
    coordinator = nil
    capabilities = nil
    authError = nil
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
