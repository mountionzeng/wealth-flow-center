import SwiftUI

@main
struct WealthFlowCenterApp: App {
    @StateObject private var store = StudyStore()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(store)
        }
    }
}
