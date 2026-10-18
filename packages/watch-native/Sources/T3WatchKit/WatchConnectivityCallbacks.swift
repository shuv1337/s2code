import Foundation
import Synchronization

/// Arbitrates callback completion under a lock because cancellation, deadlines, and framework
/// callbacks may race on different executors.
final class WatchConnectivityContinuation: Sendable {
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

/// WatchConnectivity invokes these closures on an arbitrary queue, so their function types and
/// creation context must both remain nonisolated.
struct WatchConnectivityCallbacks: Sendable {
  let replyHandler: @Sendable (Data) -> Void
  let errorHandler: @Sendable (any Error) -> Void

  nonisolated
  init(completion: WatchConnectivityContinuation,
    mapError: @escaping @Sendable (any Error) -> any Error = { @Sendable in $0 }) {
    replyHandler = { @Sendable data in completion.finish(.success(data)) }
    errorHandler = { @Sendable error in
      completion.finish(.failure(mapError(error)))
    }
  }
}
