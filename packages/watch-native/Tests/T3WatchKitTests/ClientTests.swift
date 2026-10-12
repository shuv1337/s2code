import Foundation
import Synchronization
import Testing

@testable import T3WatchKit

@Suite(.serialized) struct ClientTests {
  let base = URL(string: "https://shuvbot.example.ts.net:13773/")!
  let credentials = InMemoryCredentialStore(
    WatchCredentials(origin: URL(string: "https://shuvbot.example.ts.net:13773")!, accessToken: "secret-token"))

  var client: WatchClient {
    WatchClient(baseURL: base, credentials: credentials, session: StubURLProtocol.session())
  }

  @Test func percentEncodesThreadIdPathSegment() async throws {
    StubURLProtocol.install { _ in .json(200, Fixtures.thread()) }
    let thread = try await client.thread(id: Fixtures.threadId)
    #expect(thread.threadId == Fixtures.threadId)
    let request = try #require(StubURLProtocol.requests.first)
    #expect(
      request.url
        == "https://shuvbot.example.ts.net:13773/api/watch/v1/threads/thread%3Aproject%3A4e8c6d07-20d8-4c59-b4fe-19b9feac7ee1%3A706e1621-d9e0-44b4-8d17-ff0956618e3f"
    )
    #expect(request.headers["Authorization"] == "Bearer secret-token")
  }

  @Test func encodesListQuery() async throws {
    StubURLProtocol.install { _ in .json(200, "{\"items\":[],\"nextCursor\":null,\"snapshotRevision\":1}") }
    _ = try await client.threads(cursor: "a+b/c=", limit: 99)
    #expect(
      StubURLProtocol.requests.first?.url
        == "https://shuvbot.example.ts.net:13773/api/watch/v1/threads?cursor=a%2Bb%2Fc%3D&limit=50")
  }

  @Test func rejectedReceiptIsASuccessfulResponse() async throws {
    StubURLProtocol.install { _ in .json(200, Fixtures.rejectedReceipt) }
    let envelope = WatchCommandEnvelope(
      environmentId: Fixtures.environmentId, threadId: Fixtures.threadId, action: .send,
      targetRunId: nil, expectedProviderInstanceId: nil, text: "go", notAfter: Date())
    let receipt = try await client.submit(envelope)
    #expect(receipt.status == .rejected && receipt.error?.code == .threadBusy)
    let request = try #require(StubURLProtocol.requests.first)
    #expect(request.method == "POST")
    #expect(request.body == (try envelope.encodedBody()))
    #expect(request.headers["Content-Type"] == "application/json")
  }

  @Test func watchRequestErrorBranchesOnCodeNotStatus() async throws {
    StubURLProtocol.install { _ in .json(400, Fixtures.forbidden) }
    await #expect(throws: WatchClientError.request(code: .forbidden, message: "Watch request rejected: forbidden.")) {
      try await client.capabilities()
    }
  }

  @Test func authErrorDecodes() async throws {
    StubURLProtocol.install { _ in .json(401, Fixtures.authInvalid) }
    do {
      _ = try await client.capabilities()
      Issue.record("expected throw")
    } catch {
      #expect(error == .environment(tag: "EnvironmentAuthInvalidError", code: "auth_invalid", status: 401, reason: "invalid_token"))
      #expect(error.isUnauthorized)
    }
  }

  @Test func unknownErrorBodyKeepsStatusAndPrefix() async throws {
    StubURLProtocol.install { _ in .json(502, "<html>bad gateway</html>") }
    await #expect(throws: WatchClientError.http(status: 502, bodyPrefix: "<html>bad gateway</html>")) {
      try await client.capabilities()
    }
  }

  @Test func missingCredentialFailsWithoutNetwork() async throws {
    StubURLProtocol.install { _ in .json(200, Fixtures.capabilities) }
    let unpaired = WatchClient(baseURL: base, credentials: InMemoryCredentialStore(), session: StubURLProtocol.session())
    await #expect(throws: WatchClientError.notConfigured) { try await unpaired.capabilities() }
    #expect(StubURLProtocol.requests.isEmpty)
  }

  @Test func exchangesBootstrapCredential() async throws {
    StubURLProtocol.install { _ in
      .json(200, "{\"access_token\":\"tok\",\"issued_token_type\":\"urn:ietf:params:oauth:token-type:access_token\",\"token_type\":\"Bearer\",\"expires_in\":3600,\"scope\":\"orchestration:read orchestration:operate\"}")
    }
    let now = Date(timeIntervalSince1970: 1_000)
    let creds = try await WatchClient.exchange(
      origin: URL(string: "http://127.0.0.1:13773")!, credential: " watch.abc+def ",
      deviceType: "bot", session: StubURLProtocol.session(), now: now)
    #expect(creds.accessToken == "tok" && creds.expiresAt == now.addingTimeInterval(3600))
    #expect(!creds.description.contains("tok"))
    let request = try #require(StubURLProtocol.requests.first)
    #expect(request.url == "http://127.0.0.1:13773/oauth/token")
    #expect(request.headers["Content-Type"] == "application/x-www-form-urlencoded")
    let body = String(decoding: try #require(request.body), as: UTF8.self)
    #expect(body.contains("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Atoken-exchange"))
    #expect(body.contains("subject_token=watch.abc%2Bdef"))
    #expect(body.contains("subject_token_type=urn%3At3%3Aparams%3Aoauth%3Atoken-type%3Aenvironment-bootstrap"))
    #expect(body.contains("requested_token_type=urn%3Aietf%3Aparams%3Aoauth%3Atoken-type%3Aaccess_token"))
    #expect(body.contains("client_device_type=bot"))
    #expect(body.contains("client_label=Apple%20Watch"))
  }

  // MARK: - Coordinator over the stub

  func makeCoordinator(clock: @escaping @Sendable () -> Date = { Date() }) throws -> SubmissionCoordinator {
    let store = try SubmissionStore(
      directory: FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString))
    return SubmissionCoordinator(store: store, client: client, clock: clock)
  }

  func envelope(lifetime: TimeInterval = 90, now: Date = Date()) -> WatchCommandEnvelope {
    WatchCommandEnvelope(
      environmentId: Fixtures.environmentId, threadId: Fixtures.threadId, action: .steer,
      targetRunId: Fixtures.runId, expectedProviderInstanceId: "codex", text: "redirect",
      notAfter: now.addingTimeInterval(lifetime))
  }

  @Test func coordinatorPersistsBeforeFirstSend() async throws {
    let coordinator = try makeCoordinator()
    let store = coordinator.store
    let env = envelope()
    StubURLProtocol.install { request in
      // The persisted file must already hold this command when the request arrives.
      let onDisk = (try? Data(contentsOf: store.fileURL)).map { String(decoding: $0, as: UTF8.self) } ?? ""
      return onDisk.contains(env.commandId)
        ? .json(200, Fixtures.acceptedReceipt.replacingOccurrences(of: "3ba6faee-66a3-4542-84a1-e10c6fd83334", with: env.commandId))
        : .json(500, "not persisted")
    }
    let result = try await coordinator.submit(env, labels: .init(environment: "e", project: nil, thread: "t"))
    guard case .receipt(let receipt) = result.state else {
      Issue.record("expected receipt, got \(result.state)")
      return
    }
    #expect(receipt.status == .accepted)
  }

  @Test func coordinatorRecoversLostReplyWithIdenticalReplay() async throws {
    let coordinator = try makeCoordinator()
    let env = envelope()
    let accepted = Fixtures.acceptedReceipt.replacingOccurrences(of: "3ba6faee-66a3-4542-84a1-e10c6fd83334", with: env.commandId)
    let missing = "{\"_tag\":\"WatchRequestError\",\"code\":\"receipt_not_found\",\"message\":\"not found\"}"
    let posts = StubCounter()
    StubURLProtocol.install { request in
      if request.method == "POST" {
        return posts.increment() == 1 ? .failure(.timedOut) : .json(200, accepted)
      }
      return .json(400, missing)
    }
    let result = try await coordinator.submit(env, labels: .init(environment: "e", project: nil, thread: "t"))
    #expect(result.attempts == 2)
    guard case .receipt(let receipt) = result.state else {
      Issue.record("expected receipt, got \(result.state)")
      return
    }
    #expect(receipt.status == .accepted)
    let bodies = StubURLProtocol.requests.filter { $0.method == "POST" }.map(\.body)
    #expect(bodies.count == 2 && bodies[0] == bodies[1])
    #expect(StubURLProtocol.requests.map(\.method) == ["POST", "GET", "POST"])
    #expect(StubURLProtocol.requests[1].url.hasSuffix("/api/watch/v1/commands/\(env.commandId)"))
  }

  @Test func concurrentDrivesShareOneDelivery() async throws {
    let coordinator = try makeCoordinator()
    let env = envelope()
    try await coordinator.store.insert(
      Submission(envelope: env, labels: .init(environment: "e", project: nil, thread: "t")))
    let accepted = Fixtures.acceptedReceipt.replacingOccurrences(of: "3ba6faee-66a3-4542-84a1-e10c6fd83334", with: env.commandId)
    StubURLProtocol.install { _ in .json(200, accepted) }
    async let a = coordinator.drive(id: env.commandId)
    async let b = coordinator.drive(id: env.commandId)
    let (first, second) = try await (a, b)
    #expect(first.state == second.state)
    #expect(StubURLProtocol.requests.count == 1)
  }

  @Test func coordinatorReportsNotAdmittedAfterExpiry() async throws {
    let start = Date()
    let clock = StubClock(start)
    let coordinator = try makeCoordinator(clock: { clock.now })
    let env = envelope(lifetime: 90, now: start)
    StubURLProtocol.install { request in
      if request.method == "POST" {
        clock.advance(200)
        return .failure(.networkConnectionLost)
      }
      return .json(400, "{\"_tag\":\"WatchRequestError\",\"code\":\"receipt_not_found\",\"message\":\"nf\"}")
    }
    let result = try await coordinator.submit(env, labels: .init(environment: "e", project: nil, thread: "t"))
    #expect(result.state == .notAdmitted(.expired))
    #expect(StubURLProtocol.requests.filter { $0.method == "POST" }.count == 1)
  }
}

final class StubCounter: Sendable {
  private let value = Mutex(0)
  func increment() -> Int { value.withLock { $0 += 1; return $0 } }
}

final class StubClock: Sendable {
  private let value: Mutex<Date>
  init(_ start: Date) { value = Mutex(start) }
  var now: Date { value.withLock { $0 } }
  func advance(_ seconds: TimeInterval) { value.withLock { $0 += seconds } }
}
