import Foundation

/// One finalized instruction, persisted before its first send. The envelope never changes after
/// creation: every retry, direct or relayed, replays it byte-for-byte.
public struct Submission: Codable, Hashable, Sendable, Identifiable {
  public enum State: Codable, Hashable, Sendable {
    /// Persisted and safe to (re)send as-is. `lastError` is set when an attempt certainly never
    /// reached the server.
    case pending(lastError: String?)
    /// A request may have reached the server; look up the receipt before doing anything else.
    /// `conflict` records a `command_conflict` answer, which means resending cannot help.
    case unknown(lastError: String, conflict: Bool)
    /// The environment answered with a receipt (`accepted`, `rejected`, or `failed`).
    case receipt(WatchCommandReceipt)
    /// Definitely not admitted, and no receipt exists.
    case notAdmitted(NotAdmitted)
    /// The outcome cannot be determined from this client (e.g. conflict with no visible receipt).
    case unresolvable(String)
  }

  public enum NotAdmitted: Codable, Hashable, Sendable {
    /// `notAfter` passed without any receipt; the server will never admit it.
    case expired
    /// Refused before a receipt could exist (`WatchRequestError`, auth, malformed request).
    case refused(code: String, message: String)
  }

  public enum Event: Hashable, Sendable {
    case posted(WatchCommandReceipt)
    case postFailed(WatchClientError)
    case receiptFound(WatchCommandReceipt)
    case receiptMissing
    case lookupFailed(WatchClientError)
  }

  public enum Step: Hashable, Sendable {
    case post(WatchCommandEnvelope)
    case lookup(commandId: String)
    case done
  }

  /// Allowance for clock skew between Watch and environment and for in-flight commits.
  public static let expiryGrace: TimeInterval = 30

  public var envelope: WatchCommandEnvelope
  public var labels: WatchThreadLabels
  public var state: State
  public var attempts: Int
  public var createdAt: Date
  public var updatedAt: Date

  public var id: String { envelope.commandId }

  public init(envelope: WatchCommandEnvelope, labels: WatchThreadLabels, now: Date = Date()) {
    self.envelope = envelope
    self.labels = labels
    state = .pending(lastError: nil)
    attempts = 0
    createdAt = WatchTimestamp.truncatedToMilliseconds(now)
    updatedAt = createdAt
  }

  /// While unresolved, the same thread must not get a new command ID ("resend as new").
  public var isResolved: Bool {
    switch state {
    case .pending, .unknown: false
    case .receipt, .notAdmitted, .unresolvable: true
    }
  }

  public var nextStep: Step {
    switch state {
    case .pending: .post(envelope)
    case .unknown: .lookup(commandId: envelope.commandId)
    case .receipt, .notAdmitted, .unresolvable: .done
    }
  }

  public func applying(_ event: Event, now: Date) -> Submission {
    var next = self
    next.updatedAt = WatchTimestamp.truncatedToMilliseconds(now)
    switch (state, event) {
    case (.pending, .posted(let receipt)):
      next.attempts += 1
      if receipt.status == .rejected, receipt.error?.code == .commandConflict {
        // The server holds a different payload under this ID; its receipt is the real answer.
        next.state = .unknown(lastError: WatchCommandErrorCode.commandConflict.rawValue, conflict: true)
      } else {
        next.state = .receipt(receipt)
      }
    case (.pending, .postFailed(let error)):
      next.attempts += 1
      next.state = Self.state(afterPostFailure: error)
    case (.unknown, .receiptFound(let receipt)):
      next.state = .receipt(receipt)
    case (.unknown(_, let conflict), .receiptMissing):
      if conflict {
        next.state = .unresolvable("Command ID conflict with no visible receipt.")
      } else if now < envelope.notAfter {
        next.state = .pending(lastError: nil)
      } else if now >= envelope.notAfter.addingTimeInterval(Self.expiryGrace) {
        next.state = .notAdmitted(.expired)
      }
    case (.unknown(_, let conflict), .lookupFailed(let error)):
      next.state = .unknown(lastError: error.localizedDescription, conflict: conflict)
    default:
      return self
    }
    return next
  }

  /// A receipt missing between `notAfter` and the grace deadline is not yet proof of non-admission:
  /// an in-flight request could still commit. Look up again at the returned time.
  public func retryAfter(now: Date) -> Date? {
    guard case .unknown(_, false) = state, now >= envelope.notAfter else { return nil }
    let deadline = envelope.notAfter.addingTimeInterval(Self.expiryGrace)
    return now < deadline ? deadline : nil
  }

  private static func state(afterPostFailure error: WatchClientError) -> State {
    if error.certainlyNotDelivered {
      return .pending(lastError: error.localizedDescription)
    }
    switch error {
    case .request(let code, let message):
      return .notAdmitted(.refused(code: code.rawValue, message: message))
    case .environment(_, let code, let status, let reason) where status < 500:
      return .notAdmitted(.refused(code: code, message: reason ?? code))
    case .oauth(let code, let description, let status) where status < 500:
      return .notAdmitted(.refused(code: code, message: description ?? code))
    case .http(let status, _) where (400..<500).contains(status) && status != 408:
      return .notAdmitted(.refused(code: "http_\(status)", message: "HTTP \(status)"))
    default:
      // Timeouts, dropped connections, 5xx, and undecodable 200s may have committed.
      return .unknown(lastError: error.localizedDescription, conflict: false)
    }
  }
}
