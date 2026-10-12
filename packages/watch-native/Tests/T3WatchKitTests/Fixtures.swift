import Foundation
import Synchronization

@testable import T3WatchKit

enum Fixtures {
  static let threadId =
    "thread:project:4e8c6d07-20d8-4c59-b4fe-19b9feac7ee1:706e1621-d9e0-44b4-8d17-ff0956618e3f"
  static let runId =
    "run:thread:thread%3Aproject%3A4e8c6d07-20d8-4c59-b4fe-19b9feac7ee1%3A706e1621-d9e0-44b4-8d17-ff0956618e3f:ordinal:1"
  static let environmentId = "8b0c6fac-08fc-4853-b424-469124604464"

  static let capabilities = """
    {"protocolVersion":1,"environmentId":"8b0c6fac-08fc-4853-b424-469124604464","actions":["send","queue","steer"],"limits":{"maxTextCodePoints":8000,"maxTextBytes":32768,"maxBodyBytes":49152,"maxThreadPageSize":50},"features":{"idempotentReceipts":true,"commandExpiry":true,"threadPagination":true,"nativeSteerOnly":true,"steerFollowUp":false,"threadAllowList":true,"projectAllowList":true}}
    """

  static func thread(
    activity: String = "running", activeRunId: String? = runId, providerInstanceId: String = "codex",
    interruptsTools: Bool = false, supportsSteering: Bool = true, isReadOnly: Bool = false
  ) -> String {
    let run = activeRunId.map { "\"\($0)\"" } ?? "null"
    return """
      {"environmentId":"\(environmentId)","threadId":"\(threadId)","projectId":"4e8c6d07-20d8-4c59-b4fe-19b9feac7ee1","labels":{"environment":"shuvbot","project":"shuv2code-nightly","thread":"Watch E2E smoke"},"provider":"codex","providerInstanceId":"\(providerInstanceId)","activity":"\(activity)","activeRunId":\(run),"capabilities":{"supportsActiveSteering":\(supportsSteering),"activeSteeringInterruptsTools":\(interruptsTools),"supportsQueuedMessages":true},"queuedCount":0,"pendingAttention":{"runtimeRequest":{"id":"runtime-request:provider:codex:1","kind":"command","createdAt":"2026-10-11T23:23:31.376Z"},"hasActionableProposedPlan":false},"latestAssistantExcerpt":"I'll list the repository root…","isReadOnly":\(isReadOnly),"parentThreadId":null,"snapshotRevision":278476,"updatedAt":"2026-10-11T23:17:23.510Z"}
      """
  }

  static let acceptedReceipt = """
    {"commandId":"3ba6faee-66a3-4542-84a1-e10c6fd83334","threadId":"\(threadId)","action":"steer","observed":{"activeRunId":"\(runId)","activity":"running"},"status":"accepted","acceptedAt":"2026-10-11T23:25:40.084Z","resultSequence":278523,"error":null}
    """
  static let rejectedReceipt = """
    {"commandId":"24e4bdf8-0000-4000-8000-000000000000","threadId":"\(threadId)","action":"send","observed":{"activeRunId":"\(runId)","activity":"running"},"status":"rejected","acceptedAt":null,"resultSequence":null,"error":{"code":"thread_busy","message":"Watch command rejected: thread_busy."}}
    """
  static let failedReceipt = """
    {"commandId":"3ba6faee-66a3-4542-84a1-e10c6fd83334","threadId":"\(threadId)","action":"steer","observed":{"activeRunId":null,"activity":"completed"},"status":"failed","acceptedAt":"2026-10-11T23:25:40.084Z","resultSequence":278523,"error":{"code":"stale_target","message":"Steer target finished before it could be applied."}}
    """
  static let forbidden = """
    {"_tag":"WatchRequestError","code":"forbidden","message":"Watch request rejected: forbidden."}
    """
  static let authInvalid = """
    {"_tag":"EnvironmentAuthInvalidError","code":"auth_invalid","reason":"invalid_token","traceId":"t1"}
    """

  static func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
    try JSONDecoder.watch.decode(type, from: Data(json.utf8))
  }

  static func receipt(_ json: String, commandId: String) throws -> WatchCommandReceipt {
    var receipt = try decode(WatchCommandReceipt.self, json)
    receipt.commandId = commandId
    return receipt
  }

  static func summary(_ json: String = thread()) throws -> WatchThreadSummary {
    try decode(WatchThreadSummary.self, json)
  }
}

/// Global request stub. Suites that use it are serialized.
final class StubURLProtocol: URLProtocol {
  struct Recorded: Sendable {
    var method: String
    var url: String
    var headers: [String: String]
    var body: Data?
  }

  enum Reply: Sendable {
    case json(Int, String)
    case failure(URLError.Code)
  }

  typealias Handler = @Sendable (Recorded) -> Reply

  private static let state = Mutex<(handler: Handler?, requests: [Recorded])>((nil, []))

  static func install(_ handler: @escaping Handler) {
    state.withLock { $0 = (handler, []) }
  }

  static var requests: [Recorded] { state.withLock { $0.requests } }

  static func session() -> URLSession {
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [StubURLProtocol.self]
    return URLSession(configuration: config)
  }

  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    let recorded = Recorded(
      method: request.httpMethod ?? "GET",
      url: request.url?.absoluteString ?? "",
      headers: request.allHTTPHeaderFields ?? [:],
      body: request.httpBody ?? request.httpBodyStream.map(Self.read)
    )
    let handler = Self.state.withLock { state -> Handler? in
      state.requests.append(recorded)
      return state.handler
    }
    switch handler?(recorded) ?? .failure(.unsupportedURL) {
    case .json(let status, let body):
      let response = HTTPURLResponse(
        url: request.url!, statusCode: status, httpVersion: "HTTP/1.1",
        headerFields: ["Content-Type": "application/json"])!
      client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
      client?.urlProtocol(self, didLoad: Data(body.utf8))
      client?.urlProtocolDidFinishLoading(self)
    case .failure(let code):
      client?.urlProtocol(self, didFailWithError: URLError(code))
    }
  }

  override func stopLoading() {}

  private static func read(_ stream: InputStream) -> Data {
    stream.open()
    defer { stream.close() }
    var data = Data()
    var buffer = [UInt8](repeating: 0, count: 4096)
    while stream.hasBytesAvailable {
      let count = stream.read(&buffer, maxLength: buffer.count)
      if count <= 0 { break }
      data.append(buffer, count: count)
    }
    return data
  }
}
