import Foundation

public struct WatchHTTPResponse: Codable, Hashable, Sendable {
  public var status: Int
  public var body: Data

  public init(status: Int, body: Data) {
    self.status = status
    self.body = body
  }
}

/// Both direct HTTP and the native iPhone relay return the server's unmodified response.
public protocol WatchHTTPTransport: Sendable {
  func send(_ request: URLRequest) async throws -> WatchHTTPResponse
}

public struct DirectWatchTransport: WatchHTTPTransport {
  public let session: URLSession

  public init(session: URLSession = .shared) { self.session = session }

  public func send(_ request: URLRequest) async throws -> WatchHTTPResponse {
    let (body, response) = try await session.data(for: request)
    return WatchHTTPResponse(status: (response as? HTTPURLResponse)?.statusCode ?? 0, body: body)
  }
}

public enum WatchConnectionMode: String, Codable, CaseIterable, Sendable {
  case automatic, direct, phone

  public var label: String {
    switch self {
    case .automatic: "Automatic"
    case .direct: "Direct"
    case .phone: "iPhone"
    }
  }
}

/// Selects one route before submission. Never replays an uncertain POST on another route.
public struct RoutedWatchTransport: WatchHTTPTransport {
  public let mode: WatchConnectionMode
  public let direct: any WatchHTTPTransport
  public let phone: any WatchHTTPTransport
  public let phoneAvailable: @Sendable () async -> Bool

  public init(
    mode: WatchConnectionMode, direct: any WatchHTTPTransport = DirectWatchTransport(),
    phone: any WatchHTTPTransport, phoneAvailable: @escaping @Sendable () async -> Bool
  ) {
    self.mode = mode
    self.direct = direct
    self.phone = phone
    self.phoneAvailable = phoneAvailable
  }

  public func send(_ request: URLRequest) async throws -> WatchHTTPResponse {
    switch mode {
    case .direct: return try await direct.send(request)
    case .phone: return try await phone.send(request)
    case .automatic:
      if await phoneAvailable() { return try await phone.send(request) }
      return try await direct.send(request)
    }
  }
}
