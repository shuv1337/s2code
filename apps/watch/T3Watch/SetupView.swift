import SwiftUI
import T3WatchKit

struct SetupView: View {
  @Environment(AppModel.self) private var model
  // Debug builds prefill from the environment so the simulator can be paired
  // with `simctl launch` instead of typing on a 40 mm screen.
  @State private var origin = debugEnvironment("T3_WATCH_ORIGIN")
  @State private var credential = debugEnvironment("T3_WATCH_CREDENTIAL")
  @State private var showsManualEntry = !debugEnvironment("T3_WATCH_CREDENTIAL").isEmpty
  @State private var isExchangingManually = false
  @State private var error: String?

  var body: some View {
    Form {
      switch model.pairing {
      case .waitingForApproval(let pending, _):
        waiting(pending)
      case .starting, .approved, .exchanging:
        Section {
          HStack {
            ProgressView()
            Text(progressLabel).font(.footnote)
          }
          Button("Cancel", role: .cancel) { model.cancelDevicePairing() }
        }
      case .idle, .paired, .denied, .expired, .failed:
        start
      }
    }
    .navigationTitle("T3 Watch")
    .task { await model.resumeDevicePairing() }
  }

  @ViewBuilder
  private var start: some View {
    Section {
      TextField("https://host:13773", text: $origin)
        .textContentType(.URL)
        .autocorrectionDisabled()
        .textInputAutocapitalization(.never)
    } header: {
      Text("Environment URL")
    }
    if let message = error ?? outcomeMessage ?? model.startupError {
      Text(message).font(.footnote).foregroundStyle(.red)
    }
    Button("Pair") {
      do {
        try model.startDevicePairing(origin: origin)
        error = nil
      } catch {
        self.error = error.localizedDescription
      }
    }
    .disabled(origin.isEmpty || isExchangingManually)

    Section {
      Button {
        showsManualEntry.toggle()
      } label: {
        Label(
          "Enter credential manually",
          systemImage: showsManualEntry ? "chevron.down" : "chevron.right")
      }
      .font(.footnote)
      if showsManualEntry {
        SecureField("watch.…", text: $credential)
        Button {
          Task { await pairManually() }
        } label: {
          if isExchangingManually { ProgressView() } else { Text("Pair with credential") }
        }
        .disabled(isExchangingManually || origin.isEmpty || credential.isEmpty)
      }
    } footer: {
      if showsManualEntry { Text("From `t3 pair --watch` on the environment.") }
    }
  }

  @ViewBuilder
  private func waiting(_ pending: PairingSession.Pending) -> some View {
    Section {
      Text(pending.userCode)
        .font(.system(.title2, design: .monospaced).weight(.bold))
        .lineLimit(1)
        .minimumScaleFactor(0.5)
        .frame(maxWidth: .infinity)
      Text(pending.environment.label).font(.footnote).foregroundStyle(.secondary)
      HStack(spacing: 4) {
        Text("Expires in")
        Text(pending.expiresAt, style: .timer).monospacedDigit()
      }
      .font(.caption2).foregroundStyle(.secondary)
    } footer: {
      VStack(alignment: .leading, spacing: 2) {
        Text("Approve on your Mac:")
        Text("t3 pair --watch --approve \(pending.userCode)").font(.caption2.monospaced())
      }
    }
    Button("Cancel", role: .cancel) { model.cancelDevicePairing() }
  }

  private var progressLabel: String {
    switch model.pairing {
    case .starting: "Contacting environment…"
    default: "Approved. Finishing…"
    }
  }

  private var outcomeMessage: String? {
    switch model.pairing {
    case .denied: "Pairing was denied on the environment."
    case .expired: "The code expired. Pair again."
    case .failed(let message): message
    default: nil
    }
  }

  private func pairManually() async {
    isExchangingManually = true
    defer { isExchangingManually = false }
    do {
      try await model.pair(origin: origin, credential: credential)
      credential = ""
      error = nil
    } catch {
      self.error = error.localizedDescription
    }
  }
}

private func debugEnvironment(_ key: String) -> String {
  #if DEBUG
    return ProcessInfo.processInfo.environment[key] ?? ""
  #else
    return ""
  #endif
}
