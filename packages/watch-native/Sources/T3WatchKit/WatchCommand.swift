import Foundation

public enum WatchTextError: Error, Hashable, Sendable {
  case empty
  case tooManyScalars(count: Int)
  case tooManyBytes(count: Int)
}

public enum WatchText {
  /// Swift strings cannot hold unpaired surrogates, so only the two size limits need checking.
  public static func validate(_ text: String) throws(WatchTextError) {
    if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { throw .empty }
    let scalars = text.unicodeScalars.count
    if scalars > WatchLimits.maxTextCodePoints { throw .tooManyScalars(count: scalars) }
    let bytes = text.utf8.count
    if bytes > WatchLimits.maxTextBytes { throw .tooManyBytes(count: bytes) }
  }
}

public struct WatchCommandEnvelope: Codable, Hashable, Sendable {
  public var protocolVersion: Int
  public var commandId: String
  public var messageId: String
  public var environmentId: String
  public var threadId: String
  public var action: WatchAction
  /// Required for `steer`, omitted for `send`/`queue`.
  public var targetRunId: String?
  public var expectedProviderInstanceId: String?
  public var text: String
  public var notAfter: Date

  public init(
    commandId: UUID = UUID(), messageId: UUID = UUID(), environmentId: String, threadId: String,
    action: WatchAction, targetRunId: String?, expectedProviderInstanceId: String?, text: String,
    notAfter: Date
  ) {
    self.protocolVersion = WatchLimits.protocolVersion
    self.commandId = commandId.uuidString.lowercased()
    self.messageId = messageId.uuidString.lowercased()
    self.environmentId = environmentId
    self.threadId = threadId
    self.action = action
    self.targetRunId = action == .steer ? targetRunId : nil
    self.expectedProviderInstanceId = expectedProviderInstanceId
    self.text = text
    self.notAfter = WatchTimestamp.truncatedToMilliseconds(notAfter)
  }

  /// Exact request body. Deterministic, so a persisted envelope always replays byte-identically.
  public func encodedBody() throws -> Data {
    try JSONEncoder.watch.encode(self)
  }
}

/// Client-side mirror of server admission. The server re-checks everything inside its thread lock;
/// this only decides which choices to offer.
public enum WatchAdmissionRules {
  public static func availableActions(
    for thread: WatchThreadSummary, serverActions: [WatchAction]? = nil
  ) -> [WatchAction] {
    let candidates = actions(
      activeRunId: thread.activeRunId, capabilities: thread.capabilities,
      isReadOnly: thread.isReadOnly)
    guard let serverActions else { return candidates }
    return candidates.filter(serverActions.contains)
  }

  /// `activeRunId`, not `activity`, decides admission.
  static func actions(
    activeRunId: String?, capabilities: WatchThreadCapabilities, isReadOnly: Bool
  ) -> [WatchAction] {
    if isReadOnly { return [] }
    if activeRunId == nil { return [.send] }
    return capabilities.supportsActiveSteering ? [.steer, .queue] : [.queue]
  }

  /// Native steering that the provider reports will interrupt running tools.
  public static func disruptionWarning(for action: WatchAction, thread: WatchThreadSummary)
    -> Bool
  {
    action == .steer && thread.capabilities.activeSteeringInterruptsTools
  }
}

/// Target identity captured when composition starts. Never re-resolved by title or list order.
public struct WatchTarget: Codable, Hashable, Sendable {
  public var environmentId: String
  public var threadId: String
  public var labels: WatchThreadLabels
  public var providerInstanceId: String
  public var activeRunId: String?
  public var snapshotRevision: Int
  public var capabilities: WatchThreadCapabilities
  public var isReadOnly: Bool

  public init(thread: WatchThreadSummary) {
    environmentId = thread.environmentId
    threadId = thread.threadId
    labels = thread.labels
    providerInstanceId = thread.providerInstanceId
    activeRunId = thread.activeRunId
    snapshotRevision = thread.snapshotRevision
    capabilities = thread.capabilities
    isReadOnly = thread.isReadOnly
  }
}

public enum WatchDraftError: Error, Hashable, Sendable {
  case noActionChosen
  case actionUnavailable(WatchAction)
  case text(WatchTextError)
  case differentThread
  case bodyTooLarge(bytes: Int)
}

public struct WatchDraft: Codable, Hashable, Sendable, Identifiable {
  public enum Revalidation: Hashable, Sendable {
    case unchanged
    /// The run or provider moved while composing; the draft keeps its text and needs a fresh action.
    case targetChanged(WatchDraft)
  }

  public var id: UUID
  public private(set) var target: WatchTarget
  public var text: String
  public var action: WatchAction?
  public var createdAt: Date

  public init(thread: WatchThreadSummary, text: String = "", now: Date = Date()) {
    id = UUID()
    target = WatchTarget(thread: thread)
    self.text = text
    action = nil
    createdAt = WatchTimestamp.truncatedToMilliseconds(now)
  }

  public var availableActions: [WatchAction] {
    WatchAdmissionRules.actions(
      activeRunId: target.activeRunId, capabilities: target.capabilities,
      isReadOnly: target.isReadOnly)
  }

  public var showsDisruptionWarning: Bool {
    action == .steer && target.capabilities.activeSteeringInterruptsTools
  }

  public func revalidate(against fresh: WatchThreadSummary) throws(WatchDraftError) -> Revalidation {
    guard fresh.environmentId == target.environmentId, fresh.threadId == target.threadId else {
      throw .differentThread
    }
    if fresh.activeRunId == target.activeRunId,
      fresh.providerInstanceId == target.providerInstanceId,
      fresh.isReadOnly == target.isReadOnly
    {
      return .unchanged
    }
    var rebased = self
    let labels = target.labels
    rebased.target = WatchTarget(thread: fresh)
    rebased.target.labels = labels
    rebased.action = nil
    return .targetChanged(rebased)
  }

  public func makeEnvelope(
    now: Date = Date(),
    steerLifetime: TimeInterval = 90,
    queueLifetime: TimeInterval = 600,
    commandId: UUID = UUID(),
    messageId: UUID = UUID()
  ) throws(WatchDraftError) -> WatchCommandEnvelope {
    guard let action else { throw .noActionChosen }
    guard availableActions.contains(action) else { throw .actionUnavailable(action) }
    do { try WatchText.validate(text) } catch { throw .text(error) }
    let lifetime = action == .steer ? steerLifetime : queueLifetime
    let envelope = WatchCommandEnvelope(
      commandId: commandId,
      messageId: messageId,
      environmentId: target.environmentId,
      threadId: target.threadId,
      action: action,
      targetRunId: target.activeRunId,
      expectedProviderInstanceId: target.providerInstanceId,
      text: text,
      notAfter: now.addingTimeInterval(lifetime)
    )
    let bytes = (try? envelope.encodedBody().count) ?? Int.max
    if bytes > WatchLimits.maxBodyBytes { throw .bodyTooLarge(bytes: bytes) }
    return envelope
  }
}
