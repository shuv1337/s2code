import Foundation

/// A bounded immediate-message protocol. No message or command is put in a background delivery queue.
public enum WatchRelay {
  public static let version = 1
  public static let chunkBytes = 32 * 1_024
  public static let maxBodyBytes = 1_400_000
  public static let maxResponseBytes = 2 * 1_024 * 1_024
  public static let maxMessageBytes = 48 * 1_024

  public struct Head: Codable, Sendable, Equatable {
    public var url: URL
    public var method: String
    public var headers: [String: String]
    public var bodyBytes: Int
    public var deadline: Date

    public init(request: URLRequest, now: Date = Date()) throws {
      guard let url = request.url else { throw Failure.invalidRequest }
      self.url = url
      method = request.httpMethod ?? "GET"
      headers = request.allHTTPHeaderFields ?? [:]
      bodyBytes = request.httpBody?.count ?? 0
      deadline = now.addingTimeInterval(min(max(request.timeoutInterval, 1), 900))
      try validate(now: now)
    }

    public func validate(now: Date) throws {
      guard let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
        ["https", "http"].contains(parts.scheme?.lowercased() ?? ""),
        parts.host != nil, parts.user == nil, parts.password == nil, parts.fragment == nil,
        bodyBytes >= 0, bodyBytes <= WatchRelay.maxBodyBytes,
        deadline > now, deadline.timeIntervalSince(now) <= 901,
        headers.allSatisfy({ ["authorization", "accept", "content-type"].contains($0.key.lowercased()) })
      else { throw Failure.invalidRequest }
      let path = parts.percentEncodedPath.split(separator: "/").map(String.init)
      let isToken = path == ["oauth", "token"] && method == "POST"
      let isWatch: Bool
      if path.starts(with: ["api", "watch", "v1"]) {
        let rest = Array(path.dropFirst(3))
        switch (method, rest.count) {
        case ("GET", 1): isWatch = ["capabilities", "threads"].contains(rest[0])
        case ("GET", 2): isWatch = ["threads", "commands"].contains(rest[0])
        case ("POST", 1): isWatch = rest[0] == "commands"
        case ("POST", 2): isWatch = rest[0] == "pairing" && ["start", "token"].contains(rest[1])
        case ("POST", 3): isWatch = rest[0] == "threads" && rest[2] == "transcription"
        default: isWatch = false
        }
      } else { isWatch = false }
      guard isToken || isWatch, method != "GET" || bodyBytes == 0 else {
        throw Failure.invalidRequest
      }
      let isAudio = path.count == 6 && path.last == "transcription"
      guard isAudio || bodyBytes <= WatchLimits.maxBodyBytes else { throw Failure.invalidRequest }
    }

    public func request(body: Data, now: Date) throws -> URLRequest {
      try validate(now: now)
      guard body.count == bodyBytes else { throw Failure.invalidRequest }
      var request = URLRequest(url: url)
      request.httpMethod = method
      request.allHTTPHeaderFields = headers
      request.httpBody = body.isEmpty ? nil : body
      request.timeoutInterval = deadline.timeIntervalSince(now)
      request.cachePolicy = .reloadIgnoringLocalCacheData
      request.httpShouldHandleCookies = false
      return request
    }
  }

  public enum Operation: Codable, Sendable {
    case begin(Head)
    case append(offset: Int, bytes: Data)
    case execute
    case poll(offset: Int)
    case cancel
  }

  public struct Message: Codable, Sendable {
    public var version = WatchRelay.version
    public var id: UUID
    public var operation: Operation

    public init(id: UUID, operation: Operation) {
      self.id = id
      self.operation = operation
    }
  }

  public enum Reply: Codable, Sendable {
    case ready(offset: Int)
    case pending
    case response(status: Int, totalBytes: Int, offset: Int, bytes: Data)
    case failed(Failure)
  }

  public enum Failure: String, Error, Codable, Sendable, LocalizedError {
    case invalidRequest, busy, expired, cancelled, connectionLost, responseTooLarge

    public var errorDescription: String? {
      switch self {
      case .invalidRequest: "The iPhone relay could not read this request. Update both apps."
      case .busy: "The iPhone relay is busy. Try again."
      case .expired: "The iPhone request expired. Retry to check delivery."
      case .cancelled: "The iPhone request was cancelled."
      case .connectionLost: "The iPhone lost its connection to the environment."
      case .responseTooLarge: "The environment response is too large for the Watch."
      }
    }
  }
}

/// Shared by the native iPhone delegate and socket-free regression tests.
public actor WatchRelayServer {
  private enum State {
    case uploading(WatchRelay.Head, Data)
    case running(Task<Void, Never>)
    case finished(Result<WatchHTTPResponse, WatchRelay.Failure>)
  }
  private struct Entry {
    var state: State
    var deadline: Date
  }
  private var entries: [UUID: Entry] = [:]
  private let transport: any WatchHTTPTransport
  private let clock: @Sendable () -> Date
  public static let maxRequests = 8

  public init(transport: any WatchHTTPTransport, clock: @escaping @Sendable () -> Date = { Date() }) {
    self.transport = transport
    self.clock = clock
  }

  public func receive(_ message: WatchRelay.Message) -> WatchRelay.Reply {
    let now = clock()
    for (id, entry) in entries where entry.deadline <= now { remove(id) }
    guard message.version == WatchRelay.version else { return .failed(.invalidRequest) }
    switch message.operation {
    case .begin(let head):
      guard entries[message.id] == nil else { return .failed(.invalidRequest) }
      guard entries.count < Self.maxRequests else { return .failed(.busy) }
      do { try head.validate(now: now) } catch { return .failed(.invalidRequest) }
      entries[message.id] = Entry(state: .uploading(head, Data()), deadline: head.deadline)
      return .ready(offset: 0)
    case .append(let offset, let bytes):
      guard let entry = entries[message.id], case .uploading(let head, var body) = entry.state,
        offset == body.count, !bytes.isEmpty, bytes.count <= WatchRelay.chunkBytes,
        body.count + bytes.count <= head.bodyBytes
      else { return .failed(.invalidRequest) }
      body.append(bytes)
      entries[message.id]?.state = .uploading(head, body)
      return .ready(offset: body.count)
    case .execute:
      guard let entry = entries[message.id] else { return .failed(.expired) }
      // Repeated execute only observes an existing operation; it never forwards twice.
      guard case .uploading(let head, let body) = entry.state else { return result(message.id, offset: 0) }
      let request: URLRequest
      do { request = try head.request(body: body, now: now) } catch { return .failed(.invalidRequest) }
      let task = Task { [transport, weak self] in
        let result: Result<WatchHTTPResponse, WatchRelay.Failure>
        do {
          let response = try await transport.send(request)
          result = response.body.count <= WatchRelay.maxResponseBytes
            ? .success(response) : .failure(.responseTooLarge)
        } catch { result = .failure(Task.isCancelled ? .cancelled : .connectionLost) }
        await self?.complete(message.id, result: result)
      }
      entries[message.id]?.state = .running(task)
      return .pending
    case .poll(let offset): return result(message.id, offset: offset)
    case .cancel:
      remove(message.id)
      return .ready(offset: 0)
    }
  }

  public func cancelAll() {
    for id in Array(entries.keys) { remove(id) }
  }

  private func complete(_ id: UUID, result: Result<WatchHTTPResponse, WatchRelay.Failure>) {
    guard entries[id] != nil else { return }
    entries[id] = Entry(state: .finished(result), deadline: clock().addingTimeInterval(30))
  }

  private func result(_ id: UUID, offset: Int) -> WatchRelay.Reply {
    guard let entry = entries[id] else { return .failed(.expired) }
    switch entry.state {
    case .uploading: return .failed(.invalidRequest)
    case .running: return .pending
    case .finished(.failure(let failure)): return .failed(failure)
    case .finished(.success(let response)):
      guard offset >= 0, offset <= response.body.count else { return .failed(.invalidRequest) }
      let end = min(offset + WatchRelay.chunkBytes, response.body.count)
      return .response(status: response.status, totalBytes: response.body.count, offset: offset,
        bytes: response.body.subdata(in: offset..<end))
    }
  }

  private func remove(_ id: UUID) {
    if let entry = entries.removeValue(forKey: id), case .running(let task) = entry.state { task.cancel() }
  }
}

/// Reassembles the actual server response; a phone acknowledgement is never an HTTP success.
public struct PhoneRelayTransport: WatchHTTPTransport {
  public typealias Exchange = @Sendable (WatchRelay.Message) async throws -> WatchRelay.Reply
  private let exchange: Exchange
  private let clock: @Sendable () -> Date
  private let wait: @Sendable () async throws -> Void

  public init(exchange: @escaping Exchange, clock: @escaping @Sendable () -> Date = { Date() },
    wait: @escaping @Sendable () async throws -> Void = { try await Task.sleep(for: .milliseconds(350)) }) {
    self.exchange = exchange
    self.clock = clock
    self.wait = wait
  }

  public func send(_ request: URLRequest) async throws -> WatchHTTPResponse {
    let id = UUID()
    let head = try WatchRelay.Head(request: request, now: clock())
    return try await withTaskCancellationHandler {
      defer { Task { _ = try? await exchange(.init(id: id, operation: .cancel)) } }
      func send(_ operation: WatchRelay.Operation) async throws -> WatchRelay.Reply {
        try Task.checkCancellation()
        guard clock() < head.deadline else { throw URLError(.timedOut) }
        let reply = try await exchange(.init(id: id, operation: operation))
        if case .failed(let failure) = reply {
          throw WatchClientError.transport(code: URLError.networkConnectionLost.rawValue,
            description: failure.localizedDescription)
        }
        return reply
      }
      guard case .ready(offset: 0) = try await send(.begin(head)) else { throw WatchRelay.Failure.invalidRequest }
      let body = request.httpBody ?? Data()
      var offset = 0
      while offset < body.count {
        let end = min(offset + WatchRelay.chunkBytes, body.count)
        guard case .ready(let acknowledged) = try await send(.append(offset: offset, bytes: body.subdata(in: offset..<end))),
          acknowledged == end else { throw WatchRelay.Failure.invalidRequest }
        offset = end
      }
      var reply = try await send(.execute)
      var received = Data()
      var status: Int?
      var total: Int?
      while true {
        switch reply {
        case .pending: try await wait()
        case .response(let code, let length, let offset, let bytes):
          guard offset == received.count, length >= offset, length <= WatchRelay.maxResponseBytes,
            bytes.count <= WatchRelay.chunkBytes, offset + bytes.count <= length,
            status == nil || status == code, total == nil || total == length,
            !bytes.isEmpty || length == 0 else { throw WatchRelay.Failure.invalidRequest }
          received.append(bytes)
          status = code
          total = length
          if received.count == length { return WatchHTTPResponse(status: code, body: received) }
        default: throw WatchRelay.Failure.invalidRequest
        }
        reply = try await send(.poll(offset: received.count))
      }
    } onCancel: {
      Task { _ = try? await exchange(.init(id: id, operation: .cancel)) }
    }
  }
}
