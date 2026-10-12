import SwiftUI
import T3WatchKit

@main
struct T3WatchApp: App {
  @State private var model = AppModel()
  @Environment(\.scenePhase) private var scenePhase

  var body: some Scene {
    WindowGroup {
      RootView()
        .environment(model)
        .task(id: scenePhase) {
          if scenePhase == .active { await model.reconcile() }
        }
    }
  }
}

struct RootView: View {
  @Environment(AppModel.self) private var model

  var body: some View {
    @Bindable var model = model
    if model.isPaired {
      NavigationStack(path: $model.path) {
        ThreadsView()
          .navigationDestination(for: Route.self) { route in
            switch route {
            case .thread(let summary): ThreadView(initial: summary)
            case .compose(let summary): ComposeView(thread: summary)
            case .receipt(let commandId): ReceiptView(commandId: commandId)
            }
          }
      }
    } else {
      NavigationStack { SetupView() }
    }
  }
}
