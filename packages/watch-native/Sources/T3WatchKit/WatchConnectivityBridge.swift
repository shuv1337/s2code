#if os(iOS) || os(watchOS)
import Foundation
import Synchronization
import WatchConnectivity

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
  public static let shared = WatchConnectivityBridge()
  private let session: WCSession?
  private var server: WatchRelayServer?

  private override init() {
    session = WCSession.isSupported() ? .default : nil
    super.init()
  }

  public func activate(server: WatchRelayServer? = nil) {
    if let server { self.server = server }
    guard let session else { return }
    session.delegate = self
    session.activate()
  }

  public var isReachable: Bool {
    session?.activationState == .activated && session?.isReachable == true
  }

  public func transport(mode: WatchConnectionMode) -> any WatchHTTPTransport {
    RoutedWatchTransport(mode: mode,
      phone: PhoneRelayTransport(exchange: { [self] message in try await exchange(message) }),
      phoneAvailable: { [self] in await isReachable })
  }

  public func exchange(_ message: WatchRelay.Message) async throws -> WatchRelay.Reply {
    guard let session, session.activationState == .activated, session.isReachable else {
      throw WatchClientError.transport(code: URLError.notConnectedToInternet.rawValue,
        description: "iPhone unavailable. Open T3 Code on your iPhone and try again.")
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
      let reply: WatchRelay.Reply
      if messageData.count <= WatchRelay.maxMessageBytes,
        let message = try? JSONDecoder.watch.decode(WatchRelay.Message.self, from: messageData),
        let server = self?.server {
        reply = await server.receive(message)
      } else { reply = .failed(.invalidRequest) }
      if let encoded = try? JSONEncoder.watch.encode(reply) { handler.call(encoded) }
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
