import SwiftUI
import T3WatchKit

struct SetupView: View {
  @Environment(AppModel.self) private var model
  @State private var origin = ""
  @State private var credential = ""
  @State private var isPairing = false
  @State private var error: String?

  var body: some View {
    Form {
      Section {
        TextField("https://host:13773", text: $origin)
          .textContentType(.URL)
          .autocorrectionDisabled()
          .textInputAutocapitalization(.never)
      } header: {
        Text("Environment URL")
      }
      Section {
        SecureField("watch.…", text: $credential)
      } header: {
        Text("Credential")
      } footer: {
        Text("From `t3 pair --watch` on the environment.")
      }
      if let error = error ?? model.startupError {
        Text(error).font(.footnote).foregroundStyle(.red)
      }
      Button {
        Task { await pair() }
      } label: {
        if isPairing { ProgressView() } else { Text("Pair") }
      }
      .disabled(isPairing || origin.isEmpty || credential.isEmpty)
    }
    .navigationTitle("T3 Watch")
  }

  private func pair() async {
    isPairing = true
    defer { isPairing = false }
    do {
      try await model.pair(origin: origin, credential: credential)
      credential = ""
      error = nil
    } catch {
      self.error = error.localizedDescription
    }
  }
}
