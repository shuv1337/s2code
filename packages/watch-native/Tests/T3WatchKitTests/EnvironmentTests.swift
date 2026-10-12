import Foundation
import Synchronization
import Testing
@testable import T3WatchKit

private final class AccountMemory: EnvironmentAccountStore {
  let state = Mutex<WatchEnvironmentAccounts?>(nil)
  let fails: Bool
  init(fails: Bool = false) { self.fails = fails }
  func load() throws -> WatchEnvironmentAccounts? { state.withLock { $0 } }
  func save(_ accounts: WatchEnvironmentAccounts) throws {
    if fails { throw CocoaError(.fileWriteUnknown) }
    state.withLock { $0 = accounts }
  }
}

@Suite struct EnvironmentTests {
  func account(_ id: String) -> WatchEnvironmentAccount {
    .init(credentials: .init(origin: URL(string: "https://\(id).example")!, accessToken: "test-\(id)", environmentId: id), label: id)
  }

  @Test func selectReplaceAndRemove() throws {
    var accounts = WatchEnvironmentAccounts()
    accounts.upsert(account("one"))
    accounts.upsert(account("two"))
    accounts.select("one")
    #expect(accounts.selected?.credentials.accessToken == "test-one")
    var renewed = account("one")
    renewed.mode = .phone
    accounts.upsert(renewed)
    #expect(accounts.accounts.count == 2)
    #expect(accounts.selected?.mode == .phone)
    let restored = try JSONDecoder.watch.decode(WatchEnvironmentAccounts.self, from: JSONEncoder.watch.encode(accounts))
    #expect(restored == accounts)
    accounts.remove("one")
    #expect(accounts.selectedId == "two")
  }

  @Test func migrationPreservesLegacyOnFailedSave() throws {
    let legacy = InMemoryCredentialStore(account("one").credentials)
    let store = AccountMemory(fails: true)
    #expect(throws: CocoaError.self) { try loadEnvironmentAccounts(from: store, migrating: legacy) }
    #expect(try legacy.load() != nil)
    let retry = AccountMemory()
    let migrated = try loadEnvironmentAccounts(from: retry, migrating: legacy)
    #expect(migrated.selectedId == "one")
    #expect(try legacy.load() == nil)
    #expect(try loadEnvironmentAccounts(from: retry, migrating: legacy) == migrated)
  }

  @Test func sameThreadDraftsStayInTheirEnvironment() async throws {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: dir) }
    let store = try SubmissionStore(directory: dir)
    let first = WatchDraft(thread: try Fixtures.summary(), text: "first")
    var thread = try Fixtures.summary()
    thread.environmentId = "other"
    let second = WatchDraft(thread: thread, text: "second")
    try await store.saveDraft(first)
    try await store.saveDraft(second)
    #expect(await store.draft(environmentId: Fixtures.environmentId, threadId: thread.threadId) == first)
    #expect(await store.draft(environmentId: "other", threadId: thread.threadId) == second)
    try await store.discardDraft(environmentId: "other", threadId: thread.threadId)
    #expect(await store.draft(environmentId: Fixtures.environmentId, threadId: thread.threadId) == first)
  }

  @Test func wrongEnvironmentCannotSubmitOrReconcile() async throws {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: dir) }
    let store = try SubmissionStore(directory: dir)
    let transport = CountingTransport()
    let credentials = account("other").credentials
    let coordinator = SubmissionCoordinator(store: store, client: WatchClient(baseURL: credentials.origin,
      credentials: InMemoryCredentialStore(credentials), transport: transport))
    let envelope = WatchCommandEnvelope(environmentId: Fixtures.environmentId, threadId: Fixtures.threadId,
      action: .queue, targetRunId: nil, expectedProviderInstanceId: nil, text: "test", notAfter: Date().addingTimeInterval(60))
    let submission = Submission(envelope: envelope, labels: .init(environment: "e", project: nil, thread: "t"))
    await #expect(throws: SubmissionStoreError.wrongEnvironment) {
      try await coordinator.submit(envelope, labels: submission.labels)
    }
    #expect(await store.submissions.isEmpty)
    try await store.insert(submission)
    await coordinator.reconcileAll()
    await #expect(throws: SubmissionStoreError.wrongEnvironment) { try await coordinator.drive(id: submission.id) }
    #expect(await transport.calls == 0)
    #expect(await store.submission(id: submission.id) == submission)
  }
}

private actor CountingTransport: WatchHTTPTransport {
  var calls = 0
  func send(_ request: URLRequest) async throws -> WatchHTTPResponse {
    calls += 1
    return .init(status: 500, body: Data())
  }
}
