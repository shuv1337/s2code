import SwiftUI
import T3WatchKit

struct EnvironmentsView: View {
  @Environment(AppModel.self) private var app
  @Environment(\.dismiss) private var dismiss
  @State private var error: String?
  @State private var confirmsRemoval = false

  var body: some View {
    @Bindable var app = app
    List {
      ForEach(app.accounts.accounts) { account in
        Button {
          do { try app.selectEnvironment(account.id); dismiss() }
          catch { self.error = error.localizedDescription }
        } label: {
          HStack {
            Text(account.label)
            if account.id == app.accounts.selectedId { Image(systemName: "checkmark") }
          }
        }
      }
      if let selected = app.accounts.selected {
        Section(selected.label) {
          Picker("Connection", selection: Binding(get: { selected.mode }, set: { mode in
            do { try app.setConnectionMode(mode) } catch { self.error = error.localizedDescription }
          })) {
            ForEach(WatchConnectionMode.allCases, id: \.self) { mode in Text(mode.label).tag(mode) }
          }
          Text(selected.credentials.origin.absoluteString).font(.caption2)
          Button("Remove environment", role: .destructive) { confirmsRemoval = true }
        }
      }
      Button("Add environment") { app.cancelDevicePairing(); app.addingEnvironment = true }
      if let error { Text(error).font(.caption2).foregroundStyle(.red) }
    }
    .navigationTitle("Environments")
    .sheet(isPresented: $app.addingEnvironment, onDismiss: { app.cancelDevicePairing() }) {
      NavigationStack {
        SetupView()
          .toolbar { ToolbarItem(placement: .cancellationAction) {
            Button("Cancel") { app.cancelDevicePairing(); app.addingEnvironment = false }
          } }
      }
    }
    .confirmationDialog("Remove this environment from Watch?", isPresented: $confirmsRemoval) {
      Button("Remove", role: .destructive) { app.unpair(); dismiss() }
    }
  }
}
