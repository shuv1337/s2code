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
  public let transport: any WatchHTTPTransport
  public let timeout: TimeInterval

  public init(
    baseURL: URL, credentials: any CredentialStore, session: URLSession = .shared,
    timeout: TimeInterval = 15, transport: (any WatchHTTPTransport)? = nil
  ) {
    self.baseURL = baseURL
    self.credentials = credentials
    self.session = session
    self.timeout = timeout
    self.transport = transport ?? DirectWatchTransport(session: session)
  }

  public var environmentId: String? { (try? credentials.load())?.environmentId }

  public func capabilities() async throws(WatchClientError) -> WatchCapabilities {
    let result: WatchCapabilities = try await get(["api", "watch", "v1", "capabilities"])
    try validateEnvironment(result.environmentId)
    return result
  }

  public func threads(cursor: String? = nil, limit: Int? = nil) async throws(WatchClientError)
    -> WatchThreadPage
  {
    var query: [(String, String)] = []
    if let cursor { query.append(("cursor", cursor)) }
    if let limit { query.append(("limit", String(min(max(limit, 1), WatchLimits.maxThreadPageSize)))) }
    let page: WatchThreadPage = try await get(["api", "watch", "v1", "threads"], query: query)
    for thread in page.items { try validateEnvironment(thread.environmentId) }
    return page
  }

  public func thread(id threadId: String) async throws(WatchClientError) -> WatchThreadSummary {
    let thread: WatchThreadSummary = try await get(["api", "watch", "v1", "threads", threadId])
    try validateEnvironment(thread.environmentId)
    return thread
  }

  /// A `rejected` receipt is a successful response, not a thrown error.
  public func submit(_ envelope: WatchCommandEnvelope) async throws(WatchClientError)
    -> WatchCommandReceipt
  {
    try validateEnvironment(envelope.environmentId)
    let body: Data
    do { body = try envelope.encodedBody() } catch { throw .decoding("envelope encoding failed") }
    var request = try authorizedRequest(url: url(["api", "watch", "v1", "commands"]))
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = body
    return try await send(request)
  }

  /// Uploads a recording for transcription only. Dispatch still uses the durable command receipt.
  public func transcribe(audio: Data, threadId: String) async throws(WatchClientError) -> String {
    guard !audio.isEmpty, audio.count <= 1_048_576 else {
      throw .decoding("Record a clip of up to two minutes.")
    }
    struct Body: Encodable {
      var audioBase64: String
      var locale: String
    }
    struct Transcript: Decodable { var text: String }
    var request = try authorizedRequest(
      url: url(["api", "watch", "v1", "threads", threadId, "transcription"]))
    request.httpMethod = "POST"
    request.timeoutInterval = 900
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    do {
      request.httpBody = try JSONEncoder().encode(
        Body(audioBase64: audio.base64EncodedString(), locale: Locale.current.identifier))
    } catch { throw .decoding("recording encoding failed") }
    let result: Transcript = try await send(request)
    guard !result.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
      throw .decoding("No speech was heard. Try recording again.")
    }
    return result.text
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
    now: Date = Date(), transport: (any WatchHTTPTransport)? = nil
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
    let token: WatchTokenResponse = try await perform(request, transport: transport ?? DirectWatchTransport(session: session))
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
    origin: URL, clientLabel: String = "S2Code Watch", session: URLSession = .shared,
    transport: (any WatchHTTPTransport)? = nil
  ) async throws(WatchClientError) -> WatchPairingStart {
    struct Body: Encodable {
      var protocolVersion = WatchLimits.protocolVersion
      var clientLabel: String
    }
    return try await postJSON(
      origin: origin, segments: ["api", "watch", "v1", "pairing", "start"],
      body: Body(clientLabel: clientLabel), session: session, transport: transport)
  }

  /// Polls a device code. Unauthenticated; `approved` carries a `watch.…` bootstrap credential for
  /// `exchange(origin:credential:)`.
  public static func pollPairing(
    origin: URL, deviceCode: String, session: URLSession = .shared,
    transport: (any WatchHTTPTransport)? = nil
  ) async throws(WatchClientError) -> WatchPairingPoll {
    struct Body: Encodable {
      var protocolVersion = WatchLimits.protocolVersion
      var deviceCode: String
    }
    return try await postJSON(
      origin: origin, segments: ["api", "watch", "v1", "pairing", "token"],
      body: Body(deviceCode: deviceCode), session: session, transport: transport)
  }

  // MARK: - Plumbing

  private static func postJSON<Body: Encodable, T: Decodable>(
    origin: URL, segments: [String], body: Body, session: URLSession,
    transport: (any WatchHTTPTransport)?
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
    return try await perform(request, transport: transport ?? DirectWatchTransport(session: session))
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
    guard let stored,
      stored.origin.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        == baseURL.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")) else { throw .notConfigured }
    let token = stored.accessToken
    var request = URLRequest(url: url)
    request.timeoutInterval = timeout
    request.cachePolicy = .reloadIgnoringLocalCacheData
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    return request
  }

  private func validateEnvironment(_ actual: String) throws(WatchClientError) {
    if let expected = environmentId, actual != expected {
      throw .request(code: .environmentMismatch, message: "This instruction belongs to another environment.")
    }
  }

  private func send<T: Decodable>(_ request: URLRequest) async throws(WatchClientError) -> T {
    try await Self.perform(request, transport: transport)
  }

  private static func perform<T: Decodable>(_ request: URLRequest, transport: any WatchHTTPTransport)
    async throws(WatchClientError) -> T
  {
    let data: Data
    let response: WatchHTTPResponse
    do {
      response = try await transport.send(request)
      data = response.body
    } catch let error as WatchClientError {
      throw error
    } catch let error as URLError {
      throw .transport(code: error.code.rawValue, description: error.localizedDescription)
    } catch {
      throw .transport(code: URLError.unknown.rawValue, description: error.localizedDescription)
    }
    let status = response.status
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
