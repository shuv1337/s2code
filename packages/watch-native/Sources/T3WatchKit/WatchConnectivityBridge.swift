#if os(iOS) || os(watchOS)
import Foundation
import Synchronization
import WatchConnectivity
#if os(iOS)
import UIKit
#endif

public struct WatchPairingOffer: Codable, Hashable, Sendable {
  public var origin: URL
  public var credential: String
  public var mode: WatchConnectionMode
  public var label: String

  public init(origin: URL, credential: String, mode: WatchConnectionMode, label: String) {
    self.origin = origin
    self.credential = credential
    self.mode = mode
    self.label = label
  }
}

public struct WatchCompanionStatus: Sendable {
  public var isPaired: Bool
  public var isWatchAppInstalled: Bool
  public var phoneLabel: String

  public init(isPaired: Bool, isWatchAppInstalled: Bool, phoneLabel: String) {
    self.isPaired = isPaired
    self.isWatchAppInstalled = isWatchAppInstalled
    self.phoneLabel = phoneLabel
  }
}

public enum WatchPairingDelivery: String, Codable, Sendable {
  case paired, queued
}

private struct WatchPairingReply: Codable {
  var delivery: WatchPairingDelivery? = nil
  var error: String? = nil
}

/// Callback completion is arbitrated under a lock: cancellation, deadline and WCSession may race.
private final class RelayContinuation: Sendable {
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

/// Apple calls the reply closure on an arbitrary delegate queue. Ownership moves exactly once
/// into the receive task; it is never invoked concurrently or retained by the relay server.
private struct RelayReplyHandler: @unchecked Sendable {
  let call: (Data) -> Void
}

@MainActor
public final class WatchConnectivityBridge: NSObject, WCSessionDelegate {
  public typealias PairingReceiver = @MainActor @Sendable (WatchPairingOffer) async throws -> Void
  public static let shared = WatchConnectivityBridge()
  private let session: WCSession?
  private var server: WatchRelayServer?
  private var pairingReceiver: PairingReceiver?
  private nonisolated static let pairingUserInfoKey = "dev.shuv.s2code.watch-pairing"

  private override init() {
    session = WCSession.isSupported() ? .default : nil
    super.init()
  }

  public func activate(server: WatchRelayServer? = nil, pairingReceiver: PairingReceiver? = nil) {
    if let server { self.server = server }
    if let pairingReceiver { self.pairingReceiver = pairingReceiver }
    guard let session else { return }
    session.delegate = self
    session.activate()
  }

  public var isReachable: Bool {
    session?.activationState == .activated && session?.isReachable == true
  }

  #if os(iOS)
  public var companionStatus: WatchCompanionStatus {
    WatchCompanionStatus(
      isPaired: session?.isPaired == true,
      isWatchAppInstalled: session?.isWatchAppInstalled == true,
      phoneLabel: UIDevice.current.name)
  }

  public func offerPairing(_ offer: WatchPairingOffer) async throws -> WatchPairingDelivery {
    guard let session, session.activationState == .activated, session.isPaired,
      session.isWatchAppInstalled else {
      throw WatchClientError.transport(code: URLError.notConnectedToInternet.rawValue,
        description: "No paired Apple Watch with S2Code installed is available.")
    }
    let data = try JSONEncoder.watch.encode(offer)
    guard data.count <= WatchRelay.maxMessageBytes else { throw WatchRelay.Failure.invalidRequest }
    guard session.isReachable else {
      session.transferUserInfo([Self.pairingUserInfoKey: data])
      return .queued
    }
    let completion = RelayContinuation()
    let timer = Task {
      do { try await Task.sleep(for: .seconds(20)) } catch { return }
      completion.finish(.failure(URLError(.timedOut)))
    }
    defer { timer.cancel() }
    let dataReply = try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { continuation in
        completion.install(continuation)
        session.sendMessageData(data, replyHandler: { completion.finish(.success($0)) },
          errorHandler: { error in completion.finish(.failure(error)) })
      }
    } onCancel: { completion.finish(.failure(CancellationError())) }
    let reply = try JSONDecoder.watch.decode(WatchPairingReply.self, from: dataReply)
    if let error = reply.error {
      throw WatchClientError.transport(code: URLError.cannotConnectToHost.rawValue,
        description: error)
    }
    guard let delivery = reply.delivery else { throw WatchRelay.Failure.invalidRequest }
    return delivery
  }
  #endif

  public func transport(mode: WatchConnectionMode) -> any WatchHTTPTransport {
    RoutedWatchTransport(mode: mode,
      phone: PhoneRelayTransport(exchange: { [self] message in try await exchange(message) }),
      phoneAvailable: { [self] in await isReachable })
  }

  public func exchange(_ message: WatchRelay.Message) async throws -> WatchRelay.Reply {
    guard let session, session.activationState == .activated, session.isReachable else {
      throw WatchClientError.transport(code: URLError.notConnectedToInternet.rawValue,
        description: "iPhone unavailable. Open S2Code on your iPhone and try again.")
    }
    let data = try JSONEncoder.watch.encode(message)
    guard data.count <= WatchRelay.maxMessageBytes else { throw WatchRelay.Failure.invalidRequest }
    let completion = RelayContinuation()
    let timer = Task {
      do { try await Task.sleep(for: .seconds(12)) } catch { return }
      completion.finish(.failure(URLError(.timedOut)))
    }
    defer { timer.cancel() }
    let reply = try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { continuation in
        completion.install(continuation)
        if Task.isCancelled {
          completion.finish(.failure(CancellationError()))
          return
        }
        session.sendMessageData(data, replyHandler: { completion.finish(.success($0)) },
          errorHandler: { _ in
            // The counterpart may have received it. Receipt reconciliation decides admission.
            completion.finish(.failure(WatchClientError.transport(
              code: URLError.networkConnectionLost.rawValue,
              description: "iPhone relay connection lost. Retry to check delivery.")))
          })
      }
    } onCancel: { completion.finish(.failure(CancellationError())) }
    guard reply.count <= WatchRelay.maxMessageBytes else { throw WatchRelay.Failure.invalidRequest }
    return try JSONDecoder.watch.decode(WatchRelay.Reply.self, from: reply)
  }

  public nonisolated func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: (any Error)?) {}

  public nonisolated func session(_ session: WCSession, didReceiveMessageData messageData: Data,
    replyHandler: @escaping (Data) -> Void) {
    let handler = RelayReplyHandler(call: replyHandler)
    Task { @MainActor [weak self] in
      if let offer = try? JSONDecoder.watch.decode(WatchPairingOffer.self, from: messageData) {
        let reply: WatchPairingReply
        do {
          guard let receiver = self?.pairingReceiver else {
            throw WatchClientError.transport(code: URLError.cannotConnectToHost.rawValue,
              description: "Open S2Code on your Apple Watch and try again.")
          }
          try await receiver(offer)
          reply = WatchPairingReply(delivery: .paired)
        } catch {
          reply = WatchPairingReply(error: error.localizedDescription)
        }
        if let encoded = try? JSONEncoder.watch.encode(reply) { handler.call(encoded) }
        return
      }
      let reply: WatchRelay.Reply
      if messageData.count <= WatchRelay.maxMessageBytes,
        let message = try? JSONDecoder.watch.decode(WatchRelay.Message.self, from: messageData),
        let server = self?.server {
        reply = await server.receive(message)
      } else { reply = .failed(.invalidRequest) }
      if let encoded = try? JSONEncoder.watch.encode(reply) { handler.call(encoded) }
    }
  }

  public nonisolated func session(_ session: WCSession,
    didReceiveUserInfo userInfo: [String: Any] = [:]) {
    guard let data = userInfo[Self.pairingUserInfoKey] as? Data,
      let offer = try? JSONDecoder.watch.decode(WatchPairingOffer.self, from: data) else { return }
    Task { @MainActor [weak self] in
      try? await self?.pairingReceiver?(offer)
    }
  }

  #if os(iOS)
  public nonisolated func sessionDidBecomeInactive(_ session: WCSession) {
    Task { @MainActor [weak self] in await self?.server?.cancelAll() }
  }
  public nonisolated func sessionDidDeactivate(_ session: WCSession) {
    Task { @MainActor [weak self] in self?.session?.activate() }
  }
  #endif
}
#endif
