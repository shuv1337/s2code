import Foundation
import Security
import Synchronization

/// One paired environment. `accessToken` is a secret: never log or display it.
public struct WatchCredentials: Codable, Hashable, Sendable {
  public var origin: URL
  public var accessToken: String
  public var expiresAt: Date?
  public var scope: String?
  public var environmentId: String?

  public init(
    origin: URL, accessToken: String, expiresAt: Date? = nil, scope: String? = nil,
    environmentId: String? = nil
  ) {
    self.origin = origin
    self.accessToken = accessToken
    self.expiresAt = expiresAt
    self.scope = scope
    self.environmentId = environmentId
  }

  public func isExpired(now: Date = Date()) -> Bool {
    expiresAt.map { $0 <= now } ?? false
  }
}

extension WatchCredentials: CustomStringConvertible, CustomDebugStringConvertible {
  public var description: String { "WatchCredentials(origin: \(origin), accessToken: <redacted>)" }
  public var debugDescription: String { description }
}

public protocol CredentialStore: Sendable {
  func load() throws -> WatchCredentials?
  func save(_ credentials: WatchCredentials) throws
  func clear() throws
}

public final class InMemoryCredentialStore: CredentialStore {
  private let value: Mutex<WatchCredentials?>

  public init(_ credentials: WatchCredentials? = nil) {
    value = Mutex(credentials)
  }

  public func load() throws -> WatchCredentials? { value.withLock { $0 } }
  public func save(_ credentials: WatchCredentials) throws { value.withLock { $0 = credentials } }
  public func clear() throws { value.withLock { $0 = nil } }
}

public struct KeychainError: Error, Hashable, Sendable {
  public var status: OSStatus
}

public struct KeychainCredentialStore: CredentialStore {
  public var service: String
  public var account: String

  public init(service: String = "codes.t3.watch.credentials", account: String = "default") {
    self.service = service
    self.account = account
  }

  private var baseQuery: [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
    ]
  }

  public func load() throws -> WatchCredentials? {
    try loadData().map { try JSONDecoder.watch.decode(WatchCredentials.self, from: $0) }
  }

  func loadData() throws -> Data? {
    var query = baseQuery
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let data = result as? Data else {
      throw KeychainError(status: status)
    }
    return data
  }

  public func save(_ credentials: WatchCredentials) throws {
    try saveData(JSONEncoder.watch.encode(credentials))
  }

  func saveData(_ data: Data) throws {
    let update: [String: Any] = [
      kSecValueData as String: data,
      kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock,
    ]
    let status = SecItemUpdate(baseQuery as CFDictionary, update as CFDictionary)
    if status == errSecSuccess { return }
    guard status == errSecItemNotFound else { throw KeychainError(status: status) }
    let insert = baseQuery.merging(update) { _, new in new }
    let added = SecItemAdd(insert as CFDictionary, nil)
    guard added == errSecSuccess else { throw KeychainError(status: added) }
  }

  public func clear() throws {
    let status = SecItemDelete(baseQuery as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else {
      throw KeychainError(status: status)
    }
  }
}
