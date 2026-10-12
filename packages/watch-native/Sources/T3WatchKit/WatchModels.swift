import Foundation

// Mirrors packages/contracts/src/watch.ts. Identifiers stay as strings: the server owns their format.

public enum WatchLimits {
  public static let protocolVersion = 1
  public static let maxTextCodePoints = 8_000
  public static let maxTextBytes = 32 * 1_024
  public static let maxBodyBytes = 48 * 1_024
  public static let maxThreadPageSize = 50
  public static let defaultThreadPageSize = 20
}

public enum WatchAction: String, Codable, Hashable, Sendable, CaseIterable {
  case send, queue, steer
}

/// Unrecognized future states decode as `.unknown`, never as idle.
public enum WatchThreadActivity: String, Codable, Hashable, Sendable, CaseIterable {
  case idle, preparing, queued, starting, running, waiting, completed, interrupted, failed
  case cancelled
  case rolledBack = "rolled_back"
  case unknown

  public init(from decoder: any Decoder) throws {
    let raw = try decoder.singleValueContainer().decode(String.self)
    self = WatchThreadActivity(rawValue: raw) ?? .unknown
  }
}

/// Open set: the server may add codes, and `WatchRequestError` reuses this vocabulary.
public struct WatchCommandErrorCode: RawRepresentable, Codable, Hashable, Sendable,
  ExpressibleByStringLiteral, CustomStringConvertible
{
  public let rawValue: String
  public init(rawValue: String) { self.rawValue = rawValue }
  public init(stringLiteral value: String) { self.rawValue = value }
  public init(from decoder: any Decoder) throws {
    rawValue = try decoder.singleValueContainer().decode(String.self)
  }
  public func encode(to encoder: any Encoder) throws {
    var container = encoder.singleValueContainer()
    try container.encode(rawValue)
  }
  public var description: String { rawValue }

  public static let threadBusy: Self = "thread_busy"
  public static let threadIdle: Self = "thread_idle"
  public static let staleTarget: Self = "stale_target"
  public static let steeringUnsupported: Self = "steering_unsupported"
  public static let steeringWouldRestart: Self = "steering_would_restart"
  public static let expired: Self = "expired"
  public static let commandConflict: Self = "command_conflict"
  public static let threadNotFound: Self = "thread_not_found"
  /// `GET /commands/{id}` when no Watch-dispatched receipt exists for the command.
  public static let receiptNotFound: Self = "receipt_not_found"
  public static let threadReadOnly: Self = "thread_read_only"
  public static let forbidden: Self = "forbidden"
  public static let environmentMismatch: Self = "environment_mismatch"
  public static let providerMismatch: Self = "provider_mismatch"
  public static let invalidEnvelope: Self = "invalid_envelope"
  public static let textTooLong: Self = "text_too_long"
  public static let pairingRateLimited: Self = "pairing_rate_limited"
  /// Unknown device code, including one whose `approved` answer was already delivered.
  public static let pairingNotFound: Self = "pairing_not_found"
}

public struct WatchCapabilities: Codable, Hashable, Sendable {
  public struct Limits: Codable, Hashable, Sendable {
    public var maxTextCodePoints: Int
    public var maxTextBytes: Int
    public var maxBodyBytes: Int
    public var maxThreadPageSize: Int
  }

  public struct Features: Codable, Hashable, Sendable {
    public var idempotentReceipts: Bool
    public var commandExpiry: Bool
    public var threadPagination: Bool
    public var nativeSteerOnly: Bool
    public var steerFollowUp: Bool
    public var threadAllowList: Bool
    public var projectAllowList: Bool
  }

  public var protocolVersion: Int
  public var environmentId: String
  /// Unknown future actions are dropped rather than failing the whole document.
  public var actions: [WatchAction]
  public var limits: Limits
  public var features: Features

  private enum CodingKeys: String, CodingKey {
    case protocolVersion, environmentId, actions, limits, features
  }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    protocolVersion = try c.decode(Int.self, forKey: .protocolVersion)
    environmentId = try c.decode(String.self, forKey: .environmentId)
    actions = try c.decode([String].self, forKey: .actions).compactMap(WatchAction.init(rawValue:))
    limits = try c.decode(Limits.self, forKey: .limits)
    features = try c.decode(Features.self, forKey: .features)
  }
}

public struct WatchThreadCapabilities: Codable, Hashable, Sendable {
  public var supportsActiveSteering: Bool
  public var activeSteeringInterruptsTools: Bool
  public var supportsQueuedMessages: Bool

  public init(
    supportsActiveSteering: Bool, activeSteeringInterruptsTools: Bool, supportsQueuedMessages: Bool
  ) {
    self.supportsActiveSteering = supportsActiveSteering
    self.activeSteeringInterruptsTools = activeSteeringInterruptsTools
    self.supportsQueuedMessages = supportsQueuedMessages
  }
}

public struct WatchPendingRuntimeRequest: Codable, Hashable, Sendable {
  public var id: String
  /// `OrchestrationV2RuntimeRequest.kind`; kept as a string so new kinds still decode.
  public var kind: String
  public var createdAt: Date
}

public struct WatchPendingAttention: Codable, Hashable, Sendable {
  public var runtimeRequest: WatchPendingRuntimeRequest?
  public var hasActionableProposedPlan: Bool

  public var needsAttention: Bool { runtimeRequest != nil || hasActionableProposedPlan }
}

public struct WatchThreadLabels: Codable, Hashable, Sendable {
  public var environment: String
  public var project: String?
  public var thread: String

  public init(environment: String, project: String?, thread: String) {
    self.environment = environment
    self.project = project
    self.thread = thread
  }
}

public struct WatchThreadSummary: Codable, Hashable, Sendable, Identifiable {
  public var environmentId: String
  public var threadId: String
  public var projectId: String?
  public var labels: WatchThreadLabels
  public var provider: String
  public var providerInstanceId: String
  public var activity: WatchThreadActivity
  public var activeRunId: String?
  public var capabilities: WatchThreadCapabilities
  public var queuedCount: Int
  public var pendingAttention: WatchPendingAttention
  /// Last *completed* assistant message; may predate the current run.
  public var latestAssistantExcerpt: String?
  public var isReadOnly: Bool
  public var parentThreadId: String?
  public var snapshotRevision: Int
  public var updatedAt: Date

  public var id: String { threadId }
}

public struct WatchThreadPage: Codable, Hashable, Sendable {
  public var items: [WatchThreadSummary]
  public var nextCursor: String?
  public var snapshotRevision: Int
}

public struct WatchCommandError: Codable, Hashable, Sendable {
  public var code: WatchCommandErrorCode
  public var message: String

  public init(code: WatchCommandErrorCode, message: String) {
    self.code = code
    self.message = message
  }
}

public struct WatchCommandObservedState: Codable, Hashable, Sendable {
  public var activeRunId: String?
  public var activity: WatchThreadActivity
}

public struct WatchCommandReceipt: Codable, Hashable, Sendable {
  public enum Status: String, Codable, Hashable, Sendable {
    /// Committed by the environment; says nothing about provider completion.
    case accepted
    /// Committed but not applied afterwards (e.g. a steer whose run finished first).
    case failed
    case rejected
  }

  public var commandId: String
  public var threadId: String
  public var action: WatchAction
  public var observed: WatchCommandObservedState?
  public var status: Status
  public var acceptedAt: Date?
  public var resultSequence: Int?
  public var error: WatchCommandError?

  private enum CodingKeys: String, CodingKey {
    case commandId, threadId, action, observed, status, acceptedAt, resultSequence, error
  }

  public init(
    commandId: String, threadId: String, action: WatchAction, observed: WatchCommandObservedState?,
    status: Status, acceptedAt: Date?, resultSequence: Int?, error: WatchCommandError?
  ) {
    self.commandId = commandId
    self.threadId = threadId
    self.action = action
    self.observed = observed
    self.status = status
    self.acceptedAt = acceptedAt
    self.resultSequence = resultSequence
    self.error = error
  }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    commandId = try c.decode(String.self, forKey: .commandId)
    threadId = try c.decode(String.self, forKey: .threadId)
    action = try c.decode(WatchAction.self, forKey: .action)
    observed = try c.decodeIfPresent(WatchCommandObservedState.self, forKey: .observed)
    status = try c.decode(Status.self, forKey: .status)
    acceptedAt = try c.decodeIfPresent(Date.self, forKey: .acceptedAt)
    resultSequence = try c.decodeIfPresent(Int.self, forKey: .resultSequence)
    error = try c.decodeIfPresent(WatchCommandError.self, forKey: .error)
    let consistent =
      switch status {
      case .accepted: acceptedAt != nil && resultSequence != nil && error == nil
      case .failed: acceptedAt != nil && resultSequence != nil && error != nil
      case .rejected: acceptedAt == nil && resultSequence == nil && error != nil
      }
    guard consistent else {
      throw DecodingError.dataCorruptedError(
        forKey: .status, in: c, debugDescription: "Receipt fields do not match status \(status)")
    }
  }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(commandId, forKey: .commandId)
    try c.encode(threadId, forKey: .threadId)
    try c.encode(action, forKey: .action)
    try c.encode(observed, forKey: .observed)
    try c.encode(status, forKey: .status)
    try c.encode(acceptedAt, forKey: .acceptedAt)
    try c.encode(resultSequence, forKey: .resultSequence)
    try c.encode(error, forKey: .error)
  }
}

public struct WatchPairingEnvironment: Codable, Hashable, Sendable {
  public var id: String
  public var label: String

  public init(id: String, label: String) {
    self.id = id
    self.label = label
  }
}

/// `POST /api/watch/v1/pairing/start`.
public struct WatchPairingStart: Codable, Hashable, Sendable {
  public var deviceCode: String
  /// Shown on the Watch and typed into `t3 pair --watch --approve`.
  public var userCode: String
  public var expiresAt: Date
  /// Seconds between polls.
  public var interval: TimeInterval
  public var environment: WatchPairingEnvironment
}

/// `POST /api/watch/v1/pairing/token`, discriminated on `status`.
public enum WatchPairingPoll: Decodable, Hashable, Sendable {
  case pending
  case slowDown(interval: TimeInterval)
  /// Delivered exactly once; the device code is gone afterwards.
  case approved(credential: String, expiresAt: Date?)
  case denied
  case expired

  private enum CodingKeys: String, CodingKey {
    case status, interval, credential, expiresAt
  }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    let status = try c.decode(String.self, forKey: .status)
    switch status {
    case "pending": self = .pending
    case "slow_down": self = .slowDown(interval: try c.decode(TimeInterval.self, forKey: .interval))
    case "approved":
      self = .approved(
        credential: try c.decode(String.self, forKey: .credential),
        expiresAt: try c.decodeIfPresent(Date.self, forKey: .expiresAt))
    case "denied": self = .denied
    case "expired": self = .expired
    default:
      throw DecodingError.dataCorruptedError(
        forKey: .status, in: c, debugDescription: "Unknown pairing status \(status)")
    }
  }
}

public struct WatchTokenResponse: Codable, Hashable, Sendable {
  public var accessToken: String
  public var issuedTokenType: String?
  public var tokenType: String
  public var expiresIn: Double?
  public var scope: String?

  private enum CodingKeys: String, CodingKey {
    case accessToken = "access_token"
    case issuedTokenType = "issued_token_type"
    case tokenType = "token_type"
    case expiresIn = "expires_in"
    case scope
  }
}
