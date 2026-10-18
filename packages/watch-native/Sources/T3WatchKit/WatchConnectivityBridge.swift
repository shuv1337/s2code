#if os(iOS) || os(watchOS)
import Foundation
import WatchConnectivity
#if os(iOS)
import UIKit
#endif

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

private struct WatchPairingReply: Codable {
  var delivery: WatchPairingDelivery? = nil
  var error: String? = nil
}

/// Apple owns this non-Sendable closure and permits one reply. The lock makes moving it from the
/// delegate queue into asynchronous processing safe and prevents duplicate invocation.
private final class RelayReplyHandler: @unchecked Sendable {
  private let lock = NSLock()
  private var callback: ((Data) -> Void)?

  init(call: @escaping (Data) -> Void) {
    callback = call
  }

  func call(_ data: Data) {
    lock.lock()
    let call = callback
    callback = nil
    lock.unlock()
    call?(data)
  }
}

@MainActor
public final class WatchConnectivityBridge: NSObject, WCSessionDelegate {
  public typealias PairingReceiver =
    @MainActor @Sendable (WatchPairingOffer) async throws -> WatchPairingDelivery
  public typealias AvailabilityReceiver = @MainActor @Sendable () async -> Void
  public static let shared = WatchConnectivityBridge()
  private let session: WCSession?
  private var server: WatchRelayServer?
  private var pairingReceiver: PairingReceiver?
  private var availabilityReceiver: AvailabilityReceiver?
  private nonisolated static let pairingUserInfoKey = "dev.shuv.s2code.watch-pairing"

  private override init() {
    session = WCSession.isSupported() ? .default : nil
    super.init()
  }

  public func activate(server: WatchRelayServer? = nil, pairingReceiver: PairingReceiver? = nil,
    availabilityReceiver: AvailabilityReceiver? = nil) {
    if let server { self.server = server }
    if let pairingReceiver { self.pairingReceiver = pairingReceiver }
    if let availabilityReceiver { self.availabilityReceiver = availabilityReceiver }
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
    let completion = WatchConnectivityContinuation()
    let timer = Task {
      do { try await Task.sleep(for: .seconds(20)) } catch { return }
      completion.finish(.failure(URLError(.timedOut)))
    }
    defer { timer.cancel() }
    let dataReply = try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { continuation in
        completion.install(continuation)
        let callbacks = WatchConnectivityCallbacks(completion: completion)
        session.sendMessageData(data, replyHandler: callbacks.replyHandler,
          errorHandler: callbacks.errorHandler)
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
    let completion = WatchConnectivityContinuation()
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
        let callbacks = WatchConnectivityCallbacks(completion: completion, mapError: { @Sendable _ in
          // The counterpart may have received it. Receipt reconciliation decides admission.
          WatchClientError.transport(
            code: URLError.networkConnectionLost.rawValue,
            description: "iPhone relay connection lost. Retry to check delivery.")
        })
        session.sendMessageData(data, replyHandler: callbacks.replyHandler,
          errorHandler: callbacks.errorHandler)
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
          reply = WatchPairingReply(delivery: try await receiver(offer))
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
      _ = try? await self?.pairingReceiver?(offer)
    }
  }

  public nonisolated func sessionReachabilityDidChange(_ session: WCSession) {
    guard session.isReachable else { return }
    Task { @MainActor [weak self] in await self?.availabilityReceiver?() }
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
