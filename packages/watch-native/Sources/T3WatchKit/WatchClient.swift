import Foundation

public enum WatchClientError: Error, Hashable, Sendable {
  /// No stored credential.
  case notConfigured
  /// `WatchRequestError`: always HTTP 400 regardless of `code` (including `forbidden`).
  case request(code: WatchCommandErrorCode, message: String)
  /// Tagged environment errors such as `EnvironmentAuthInvalidError` (`code: auth_invalid`, 401).
  case environment(tag: String, code: String, status: Int, reason: String?)
  /// RFC 6749 token-endpoint error body.
  case oauth(error: String, description: String?, status: Int)
  case http(status: Int, bodyPrefix: String)
  case transport(code: Int, description: String)
  case decoding(String)

  public var isUnauthorized: Bool {
    switch self {
    case .notConfigured: true
    case .environment(_, let code, let status, _): code == "auth_invalid" || status == 401
    case .http(let status, _): status == 401
    default: false
    }
  }

  /// The request certainly never reached the server, so the same envelope can be resent freely.
  public var certainlyNotDelivered: Bool {
    guard case .transport(let code, _) = self else { return self == .notConfigured }
    let notSent: Set<URLError.Code> = [
      .notConnectedToInternet, .cannotFindHost, .cannotConnectToHost, .dnsLookupFailed,
      .badURL, .unsupportedURL, .appTransportSecurityRequiresSecureConnection,
      .internationalRoamingOff, .dataNotAllowed, .callIsActive,
    ]
    return notSent.contains(URLError.Code(rawValue: code))
  }
}

extension WatchClientError: LocalizedError {
  public var errorDescription: String? {
    switch self {
    case .notConfigured: "Not paired with an environment."
    case .request(let code, let message): "\(message) (\(code))"
    case .environment(_, let code, let status, let reason):
      code == "auth_invalid" ? "Credential rejected. Pair again." : "\(code) \(reason ?? "") (\(status))"
    case .oauth(let error, let description, _): description ?? error
    case .http(let status, _): "Server returned HTTP \(status)."
    case .transport(_, let description): description
    case .decoding(let detail): "Unexpected server response: \(detail)"
    }
  }
}

public struct WatchClient: Sendable {
  public let baseURL: URL
  public let credentials: any CredentialStore
  public let session: URLSession
  public let timeout: TimeInterval

  public init(
    baseURL: URL, credentials: any CredentialStore, session: URLSession = .shared,
    timeout: TimeInterval = 15
  ) {
    self.baseURL = baseURL
    self.credentials = credentials
    self.session = session
    self.timeout = timeout
  }

  public func capabilities() async throws(WatchClientError) -> WatchCapabilities {
    try await get(["api", "watch", "v1", "capabilities"])
  }

  public func threads(cursor: String? = nil, limit: Int? = nil) async throws(WatchClientError)
    -> WatchThreadPage
  {
    var query: [(String, String)] = []
    if let cursor { query.append(("cursor", cursor)) }
    if let limit { query.append(("limit", String(min(max(limit, 1), WatchLimits.maxThreadPageSize)))) }
    return try await get(["api", "watch", "v1", "threads"], query: query)
  }

  public func thread(id threadId: String) async throws(WatchClientError) -> WatchThreadSummary {
    try await get(["api", "watch", "v1", "threads", threadId])
  }

  /// A `rejected` receipt is a successful response, not a thrown error.
  public func submit(_ envelope: WatchCommandEnvelope) async throws(WatchClientError)
    -> WatchCommandReceipt
  {
    let body: Data
    do { body = try envelope.encodedBody() } catch { throw .decoding("envelope encoding failed") }
    var request = try authorizedRequest(url: url(["api", "watch", "v1", "commands"]))
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = body
    return try await send(request)
  }

  public func receipt(commandId: String) async throws(WatchClientError) -> WatchCommandReceipt {
    try await get(["api", "watch", "v1", "commands", commandId])
  }

  /// Exchanges a `watch.…` bootstrap credential from `pair --watch` for a bearer session.
  public static func exchange(
    origin: URL,
    credential: String,
    clientLabel: String? = "Apple Watch",
    deviceType: String = "mobile",
    session: URLSession = .shared,
    now: Date = Date()
  ) async throws(WatchClientError) -> WatchCredentials {
    var fields: [(String, String)] = [
      ("grant_type", "urn:ietf:params:oauth:grant-type:token-exchange"),
      ("subject_token", credential.trimmingCharacters(in: .whitespacesAndNewlines)),
      ("subject_token_type", "urn:t3:params:oauth:token-type:environment-bootstrap"),
      ("requested_token_type", "urn:ietf:params:oauth:token-type:access_token"),
      ("client_device_type", deviceType),
    ]
    if let clientLabel { fields.append(("client_label", clientLabel)) }
    var request = URLRequest(url: buildURL(base: origin, segments: ["oauth", "token"], query: []))
    request.httpMethod = "POST"
    request.timeoutInterval = 15
    request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    request.httpBody = Data(
      fields.map { "\(encodeComponent($0.0))=\(encodeComponent($0.1))" }.joined(separator: "&").utf8)
    let token: WatchTokenResponse = try await perform(request, session: session)
    guard token.tokenType.caseInsensitiveCompare("Bearer") == .orderedSame else {
      throw .decoding("unsupported token_type \(token.tokenType)")
    }
    return WatchCredentials(
      origin: origin,
      accessToken: token.accessToken,
      expiresAt: token.expiresIn.map { now.addingTimeInterval($0) },
      scope: token.scope
    )
  }

  /// Starts device-code pairing. Unauthenticated; the user approves `userCode` on the environment.
  public static func startPairing(
    origin: URL, clientLabel: String = "T3 Watch", session: URLSession = .shared
  ) async throws(WatchClientError) -> WatchPairingStart {
    struct Body: Encodable {
      var protocolVersion = WatchLimits.protocolVersion
      var clientLabel: String
    }
    return try await postJSON(
      origin: origin, segments: ["api", "watch", "v1", "pairing", "start"],
      body: Body(clientLabel: clientLabel), session: session)
  }

  /// Polls a device code. Unauthenticated; `approved` carries a `watch.…` bootstrap credential for
  /// `exchange(origin:credential:)`.
  public static func pollPairing(
    origin: URL, deviceCode: String, session: URLSession = .shared
  ) async throws(WatchClientError) -> WatchPairingPoll {
    struct Body: Encodable {
      var protocolVersion = WatchLimits.protocolVersion
      var deviceCode: String
    }
    return try await postJSON(
      origin: origin, segments: ["api", "watch", "v1", "pairing", "token"],
      body: Body(deviceCode: deviceCode), session: session)
  }

  // MARK: - Plumbing

  private static func postJSON<Body: Encodable, T: Decodable>(
    origin: URL, segments: [String], body: Body, session: URLSession
  ) async throws(WatchClientError) -> T {
    var request = URLRequest(url: buildURL(base: origin, segments: segments, query: []))
    request.httpMethod = "POST"
    request.timeoutInterval = 15
    request.cachePolicy = .reloadIgnoringLocalCacheData
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    do { request.httpBody = try JSONEncoder.watch.encode(body) } catch {
      throw .decoding("request encoding failed")
    }
    return try await perform(request, session: session)
  }

  private func get<T: Decodable>(_ segments: [String], query: [(String, String)] = [])
    async throws(WatchClientError) -> T
  {
    let request = try authorizedRequest(url: url(segments, query: query))
    return try await send(request)
  }

  private func url(_ segments: [String], query: [(String, String)] = []) -> URL {
    Self.buildURL(base: baseURL, segments: segments, query: query)
  }

  private func authorizedRequest(url: URL) throws(WatchClientError) -> URLRequest {
    let stored: WatchCredentials?
    do { stored = try credentials.load() } catch { throw .notConfigured }
    guard let token = stored?.accessToken else { throw .notConfigured }
    var request = URLRequest(url: url)
    request.timeoutInterval = timeout
    request.cachePolicy = .reloadIgnoringLocalCacheData
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    return request
  }

  private func send<T: Decodable>(_ request: URLRequest) async throws(WatchClientError) -> T {
    try await Self.perform(request, session: session)
  }

  private static func perform<T: Decodable>(_ request: URLRequest, session: URLSession)
    async throws(WatchClientError) -> T
  {
    let data: Data
    let response: URLResponse
    do {
      (data, response) = try await session.data(for: request)
    } catch let error as URLError {
      throw .transport(code: error.code.rawValue, description: error.localizedDescription)
    } catch {
      throw .transport(code: URLError.unknown.rawValue, description: error.localizedDescription)
    }
    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
    guard (200..<300).contains(status) else { throw decodeError(status: status, body: data) }
    do {
      return try JSONDecoder.watch.decode(T.self, from: data)
    } catch {
      throw .decoding(String(describing: error))
    }
  }

  static func decodeError(status: Int, body: Data) -> WatchClientError {
    struct Tagged: Decodable {
      var _tag: String?
      var code: String?
      var message: String?
      var reason: String?
      var error: String?
      var error_description: String?
    }
    if let tagged = try? JSONDecoder().decode(Tagged.self, from: body) {
      if tagged._tag == "WatchRequestError", let code = tagged.code {
        return .request(code: WatchCommandErrorCode(rawValue: code), message: tagged.message ?? code)
      }
      if let tag = tagged._tag, let code = tagged.code {
        return .environment(tag: tag, code: code, status: status, reason: tagged.reason)
      }
      if let error = tagged.error {
        return .oauth(error: error, description: tagged.error_description, status: status)
      }
    }
    let prefix = String(decoding: body.prefix(256), as: UTF8.self)
    return .http(status: status, bodyPrefix: prefix)
  }

  static func buildURL(base: URL, segments: [String], query: [(String, String)]) -> URL {
    var string = base.absoluteString
    while string.hasSuffix("/") { string.removeLast() }
    string += "/" + segments.map(encodeComponent).joined(separator: "/")
    if !query.isEmpty {
      string += "?" + query.map { "\(encodeComponent($0.0))=\(encodeComponent($0.1))" }
        .joined(separator: "&")
    }
    return URL(string: string)!
  }

  /// RFC 3986 unreserved characters only; thread IDs contain `:` and `%`.
  static func encodeComponent(_ value: String) -> String {
    value.addingPercentEncoding(withAllowedCharacters: unreserved) ?? value
  }

  private static let unreserved = CharacterSet(
    charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
}
