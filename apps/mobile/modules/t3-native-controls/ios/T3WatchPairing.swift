import Foundation
import Synchronization
import UIKit
import WatchConnectivity

private struct T3WatchPairingOffer: Codable {
  var id: UUID
  var origin: URL
  var credential: String
  var mode: String
  var label: String
  var issuedAt: String
  var expiresAt: String
}

private struct T3WatchPairingReply: Codable {
  var delivery: String?
  var error: String?
}

private final class T3WatchPairingContinuation: Sendable {
  private struct State {
    var continuation: CheckedContinuation<Data, any Error>?
    var result: Result<Data, any Error>?
    var completed = false
  }

  private let state = Mutex(State())

  func install(_ continuation: CheckedContinuation<Data, any Error>) {
    let ready = state.withLock { state -> Result<Data, any Error>? in
      if let result = state.result { return result }
      state.continuation = continuation
      return nil
    }
    if let ready { continuation.resume(with: ready) }
  }

  func finish(_ result: Result<Data, any Error>) {
    let continuation = state.withLock { state -> CheckedContinuation<Data, any Error>? in
      guard !state.completed else { return nil }
      state.completed = true
      state.result = result
      let continuation = state.continuation
      state.continuation = nil
      return continuation
    }
    continuation?.resume(with: result)
  }
}

@MainActor
enum T3WatchPairing {
  private static let pairingUserInfoKey = "dev.shuv.s2code.watch-pairing"

  static var companionStatus: [String: Any] {
    guard WCSession.isSupported() else {
      return ["isPaired": false, "isWatchAppInstalled": false, "phoneLabel": UIDevice.current.name]
    }
    let session = WCSession.default
    return [
      "isPaired": session.isPaired,
      "isWatchAppInstalled": session.isWatchAppInstalled,
      "phoneLabel": UIDevice.current.name,
    ]
  }

  static func offer(origin: URL, credential: String, mode: String, label: String,
    issuedAt: String, expiresAt: String) async throws -> String {
    guard WCSession.isSupported() else { throw unavailable() }
    let session = WCSession.default
    guard session.activationState == .activated, session.isPaired, session.isWatchAppInstalled else {
      throw unavailable()
    }
    guard parseDate(issuedAt) != nil, parseDate(expiresAt) != nil else {
      throw invalidReply()
    }
    let data = try JSONEncoder().encode(T3WatchPairingOffer(
      id: UUID(), origin: origin, credential: credential, mode: mode, label: label,
      issuedAt: issuedAt, expiresAt: expiresAt))
    guard data.count <= 64 * 1_024 else { throw invalidReply() }
    guard session.isReachable else {
      session.transferUserInfo([pairingUserInfoKey: data])
      return "queued"
    }

    let completion = T3WatchPairingContinuation()
    let timer = Task {
      do { try await Task.sleep(for: .seconds(20)) } catch { return }
      completion.finish(.failure(URLError(.timedOut)))
    }
    defer { timer.cancel() }
    let response = try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { continuation in
        completion.install(continuation)
        let replyHandler: @Sendable (Data) -> Void = { @Sendable data in
          completion.finish(.success(data))
        }
        let errorHandler: @Sendable (any Error) -> Void = { @Sendable error in
          completion.finish(.failure(error))
        }
        session.sendMessageData(data, replyHandler: replyHandler, errorHandler: errorHandler)
      }
    } onCancel: {
      completion.finish(.failure(CancellationError()))
    }
    let reply = try JSONDecoder().decode(T3WatchPairingReply.self, from: response)
    if let error = reply.error {
      throw NSError(domain: "T3WatchPairing", code: 2,
        userInfo: [NSLocalizedDescriptionKey: error])
    }
    guard let delivery = reply.delivery, delivery == "paired" || delivery == "queued" else {
      throw invalidReply()
    }
    return delivery
  }

  private static func unavailable() -> NSError {
    NSError(domain: "T3WatchPairing", code: 1, userInfo: [
      NSLocalizedDescriptionKey: "No paired Apple Watch with S2Code installed is available.",
    ])
  }

  private static func invalidReply() -> NSError {
    NSError(domain: "T3WatchPairing", code: 2, userInfo: [
      NSLocalizedDescriptionKey: "The Apple Watch returned an invalid pairing response.",
    ])
  }

  private static func parseDate(_ value: String) -> Date? {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.date(from: value) ?? ISO8601DateFormatter().date(from: value)
  }
}
