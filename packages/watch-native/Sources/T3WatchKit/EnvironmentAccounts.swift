import Foundation

public struct WatchEnvironmentAccount: Codable, Hashable, Sendable, Identifiable {
  public var credentials: WatchCredentials
  public var label: String
  public var mode: WatchConnectionMode
  public var id: String { credentials.environmentId ?? credentials.origin.absoluteString }

  public init(credentials: WatchCredentials, label: String, mode: WatchConnectionMode = .automatic) {
    self.credentials = credentials
    self.label = label
    self.mode = mode
  }
}

public struct WatchEnvironmentAccounts: Codable, Hashable, Sendable {
  public private(set) var accounts: [WatchEnvironmentAccount] = []
  public private(set) var selectedId: String?
  public var selected: WatchEnvironmentAccount? { accounts.first { $0.id == selectedId } }
  public init() {}

  public mutating func upsert(_ account: WatchEnvironmentAccount) {
    // Re-pairing the same origin replaces a legacy account without an environment ID.
    accounts.removeAll { $0.id == account.id || $0.credentials.origin == account.credentials.origin }
    accounts.append(account)
    selectedId = account.id
  }

  public mutating func select(_ id: String) {
    if accounts.contains(where: { $0.id == id }) { selectedId = id }
  }

  public mutating func remove(_ id: String) {
    accounts.removeAll { $0.id == id }
    if selectedId == id { selectedId = accounts.first?.id }
  }
}

public protocol EnvironmentAccountStore: Sendable {
  func load() throws -> WatchEnvironmentAccounts?
  func save(_ accounts: WatchEnvironmentAccounts) throws
}

public struct KeychainEnvironmentAccountStore: EnvironmentAccountStore {
  private let item = KeychainCredentialStore(account: "environments-v1")
  public init() {}
  public func load() throws -> WatchEnvironmentAccounts? {
    try item.loadData().map { try JSONDecoder.watch.decode(WatchEnvironmentAccounts.self, from: $0) }
  }
  public func save(_ accounts: WatchEnvironmentAccounts) throws {
    try item.saveData(JSONEncoder.watch.encode(accounts))
  }
}

/// Save the aggregate before clearing the old item. A failed write leaves pairing recoverable.
public func loadEnvironmentAccounts(
  from store: any EnvironmentAccountStore, migrating legacy: any CredentialStore
) throws -> WatchEnvironmentAccounts {
  if let accounts = try store.load() { return accounts }
  var accounts = WatchEnvironmentAccounts()
  if let credentials = try legacy.load() {
    accounts.upsert(.init(credentials: credentials, label: credentials.origin.host() ?? "Environment"))
    try store.save(accounts)
    try legacy.clear()
  }
  return accounts
}
