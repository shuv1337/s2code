import Foundation
import Synchronization
import Testing
@testable import T3WatchKit

private final class RelayHTTPStub: WatchHTTPTransport, Sendable {
  let requests = Mutex<[URLRequest]>([])
  let reply: WatchHTTPResponse
  let fails: Bool
  init(reply: WatchHTTPResponse, fails: Bool = false) { self.reply = reply; self.fails = fails }
  func send(_ request: URLRequest) async throws -> WatchHTTPResponse {
    requests.withLock { $0.append(request) }
    if fails { throw URLError(.networkConnectionLost) }
    return reply
  }
}

struct RelayTests {
  func recordingRequest() -> URLRequest {
    var request = URLRequest(url: URL(string: "https://shuvdev.example:3790/api/watch/v1/threads/test/transcription")!)
    request.httpMethod = "POST"
    request.httpBody = Data(repeating: 65, count: 1_390_000)
    request.setValue("Bearer watch-session", forHTTPHeaderField: "Authorization")
    return request
  }

  @Test func chunksAudioAndResponseWithoutChangingCredentialsOrBody() async throws {
    let expected = WatchHTTPResponse(status: 200, body: Data(repeating: 78, count: 120_000))
    let http = RelayHTTPStub(reply: expected)
    let server = WatchRelayServer(transport: http)
    let transport = PhoneRelayTransport(exchange: { message in
      let encoded = try JSONEncoder.watch.encode(message)
      #expect(encoded.count < WatchRelay.maxMessageBytes)
      return await server.receive(message)
    }, wait: { await Task.yield() })
    let request = recordingRequest()
    #expect(try await transport.send(request) == expected)
    #expect(http.requests.withLock { $0.count } == 1)
    let forwarded = try #require(http.requests.withLock { $0.first })
    #expect(forwarded.url == request.url)
    #expect(forwarded.httpBody == request.httpBody)
    #expect(forwarded.value(forHTTPHeaderField: "Authorization") == "Bearer watch-session")
  }

  @Test func repeatedExecuteDoesNotForwardAgain() async throws {
    let http = RelayHTTPStub(reply: .init(status: 200, body: Data()))
    let server = WatchRelayServer(transport: http)
    let transport = PhoneRelayTransport(exchange: { message in
      let result = await server.receive(message)
      if case .execute = message.operation { _ = await server.receive(message) }
      return result
    }, wait: { await Task.yield() })
    let request = URLRequest(url: URL(string: "https://host/api/watch/v1/capabilities")!)
    #expect(try await transport.send(request).status == 200)
    #expect(http.requests.withLock { $0.count } == 1)
  }

  @Test func partialOrCancelledUploadNeverDispatches() async throws {
    let http = RelayHTTPStub(reply: .init(status: 200, body: Data()))
    let server = WatchRelayServer(transport: http)
    let id = UUID()
    _ = await server.receive(.init(id: id, operation: .begin(try .init(request: recordingRequest()))))
    let incomplete = await server.receive(.init(id: id, operation: .execute))
    guard case .failed(.invalidRequest) = incomplete else { Issue.record("Accepted incomplete upload"); return }
    _ = await server.receive(.init(id: id, operation: .cancel))
    let cancelled = await server.receive(.init(id: id, operation: .execute))
    guard case .failed(.expired) = cancelled else { Issue.record("Revived cancelled upload"); return }
    #expect(http.requests.withLock { $0.isEmpty })
  }

  @Test func rejectsOtherEndpointsAndExpiredRequests() throws {
    var request = recordingRequest()
    request.url = URL(string: "https://host/api/admin/delete")!
    #expect(throws: WatchRelay.Failure.invalidRequest) { try WatchRelay.Head(request: request) }
    var head = try WatchRelay.Head(request: recordingRequest())
    head.deadline = Date.distantPast
    #expect(throws: WatchRelay.Failure.invalidRequest) { try head.validate(now: Date()) }
  }

  @Test func relayHTTPErrorIsNotAcknowledgementSuccess() async throws {
    let expected = WatchHTTPResponse(status: 403, body: Data("denied".utf8))
    let http = RelayHTTPStub(reply: expected)
    let server = WatchRelayServer(transport: http)
    let transport = PhoneRelayTransport(exchange: { await server.receive($0) }, wait: { await Task.yield() })
    #expect(try await transport.send(recordingRequest()) == expected)
  }

  @Test func uncertainPhoneFailureNeverFallsBackAndPostsAgain() async throws {
    let direct = RelayHTTPStub(reply: .init(status: 200, body: Data()))
    let phone = RelayHTTPStub(reply: .init(status: 200, body: Data()), fails: true)
    let transport = RoutedWatchTransport(mode: .automatic, direct: direct, phone: phone, phoneAvailable: { true })
    await #expect(throws: URLError.self) { try await transport.send(recordingRequest()) }
    #expect(phone.requests.withLock { $0.count } == 1)
    #expect(direct.requests.withLock { $0.isEmpty })
  }

  @Test func automaticUsesDirectWhenPhoneUnavailable() async throws {
    let direct = RelayHTTPStub(reply: .init(status: 200, body: Data()))
    let phone = RelayHTTPStub(reply: .init(status: 200, body: Data()))
    let transport = RoutedWatchTransport(mode: .automatic, direct: direct, phone: phone, phoneAvailable: { false })
    _ = try await transport.send(recordingRequest())
    #expect(direct.requests.withLock { $0.count } == 1)
    #expect(phone.requests.withLock { $0.isEmpty })
  }
}
