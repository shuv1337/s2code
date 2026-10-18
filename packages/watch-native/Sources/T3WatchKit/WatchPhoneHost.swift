#if os(iOS)
import Foundation
import UIKit

/// Activated before React starts, including launches caused by a Watch message.
@MainActor
public enum WatchPhoneHost {
  public static func activate() {
    WatchConnectivityBridge.shared.activate(server: WatchRelayServer(transport: PhoneHTTPTransport()))
  }
}

private final class NoRedirects: NSObject, URLSessionTaskDelegate, Sendable {
  func urlSession(_ session: URLSession, task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
    completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
    completionHandler(nil)
  }
}

private struct PhoneHTTPTransport: WatchHTTPTransport {
  private let session: URLSession
  init() {
    let config = URLSessionConfiguration.ephemeral
    config.httpCookieStorage = nil
    config.httpShouldSetCookies = false
    config.urlCredentialStorage = nil
    config.urlCache = nil
    session = URLSession(configuration: config, delegate: NoRedirects(), delegateQueue: nil)
  }

  func send(_ request: URLRequest) async throws -> WatchHTTPResponse {
    let task = Task { try await DirectWatchTransport(session: session).send(request) }
    let background = await MainActor.run {
      UIApplication.shared.beginBackgroundTask(withName: "S2Code Watch request") { task.cancel() }
    }
    do {
      let response = try await withTaskCancellationHandler { try await task.value }
        onCancel: { task.cancel() }
      await finish(background)
      return response
    } catch {
      await finish(background)
      throw error
    }
  }

  @MainActor private func finish(_ id: UIBackgroundTaskIdentifier) {
    if id != .invalid { UIApplication.shared.endBackgroundTask(id) }
  }
}
#endif
