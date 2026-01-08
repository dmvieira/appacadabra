import ExpoModulesCore
import UIKit

public class ShortcutsModule: Module {
  public func definition() -> ModuleDefinition {
    Name("Shortcuts")

    AsyncFunction("createShortcut") { (id: String, name: String, iconPath: String?, promise: Promise) in
      if #available(iOS 12.0, *) {
        let activity = NSUserActivity(activityType: "com.appacadabra.app.run")
        activity.title = "Run \(name)"
        activity.userInfo = ["id": id, "mode": "run"]
        activity.isEligibleForSearch = true
        activity.isEligibleForPrediction = true
        activity.persistentIdentifier = "app_\(id)"
        activity.suggestedInvocationPhrase = "Run \(name)"
        activity.becomeCurrent()
        promise.resolve(true)
      } else {
        promise.resolve(false)
      }
    }

    AsyncFunction("setDynamicShortcuts") { (items: [[String: String]]) in
        let shortcutItems = items.compactMap { item -> UIApplicationShortcutItem? in
            guard let id = item["id"], let name = item["name"] else { return nil }
            // Note: Custom icons for Quick Actions on iOS are complex (require asset catalog or strict system types).
            // We'll use a default system icon for now to ensure reliability.
            return UIApplicationShortcutItem(
                type: "com.appacadabra.app.run",
                localizedTitle: name,
                localizedSubtitle: nil,
                icon: UIApplicationShortcutIcon(type: .play),
                userInfo: ["id": id as NSSecureCoding, "mode": "run" as NSSecureCoding]
            )
        }
        
        DispatchQueue.main.async {
            UIApplication.shared.shortcutItems = shortcutItems
        }
    }
  }
}
