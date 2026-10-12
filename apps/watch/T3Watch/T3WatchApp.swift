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
    content
      .sensoryFeedback(.success, trigger: model.isPaired) { wasPaired, isPaired in
        !wasPaired && isPaired
      }
  }

  @ViewBuilder
  private var content: some View {
    @Bindable var model = model
    if model.isPaired {
      NavigationStack(path: $model.path) {
        ThreadsView()
          .navigationDestination(for: Route.self) { route in
            switch route {
            case .thread(let summary, let fetchedAt): ThreadView(initial: summary, fetchedAt: fetchedAt)
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
