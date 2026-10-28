import SwiftUI

@main
struct S2CodeTVApp: App {
  @State private var model = TVModel()

  var body: some Scene {
    WindowGroup {
      Group {
        if model.servers.isEmpty || model.addingServer {
          SetupView(model: model)
        } else {
          DashboardView(model: model)
        }
      }
      .task {
        await model.resumePairing()
        #if DEBUG
          // Simulators cannot drive the tvOS keyboard: `-S2CodeTVPairOrigin http://host:port`.
          // After resume, so a code already on disk is not replaced by a new exchange.
          model.consumeLaunchPairOrigin()
        #endif
      }
    }
  }
}
