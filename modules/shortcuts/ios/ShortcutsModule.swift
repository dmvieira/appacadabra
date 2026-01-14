import ExpoModulesCore
import UIKit
import CoreSpotlight
import MobileCoreServices

public class ShortcutsModule: Module {
  public func definition() -> ModuleDefinition {
    Name("Shortcuts")

    AsyncFunction("createShortcut") { (id: String, name: String, iconPath: String?) -> Bool in
        // Donate Siri Shortcut (NSUserActivity)
        let activity = NSUserActivity(activityType: "com.dmvieira.appacadabra.run")
        activity.title = name
        activity.userInfo = ["appId": id]
        activity.isEligibleForSearch = true
        if #available(iOS 12.0, *) {
            activity.isEligibleForPrediction = true
            activity.persistentIdentifier = id
        }
        
        let attributes = CSSearchableItemAttributeSet(itemContentType: kUTTypeItem as String)
        attributes.title = name
        attributes.displayName = name
        
        if let iconPath = iconPath {
            var path = iconPath
            if path.hasPrefix("file://") {
                path = String(path.dropFirst(7))
            }
            
            // Handle URL encoding if present (simple check)
            if path.contains("%") {
                path = path.removingPercentEncoding ?? path
            }

            if let image = UIImage(contentsOfFile: path),
               let imageData = image.pngData() {
                attributes.thumbnailData = imageData
            }
        }
        
        activity.contentAttributeSet = attributes
        
        activity.becomeCurrent()
        return true
    }

    AsyncFunction("setDynamicShortcuts") { (items: [[String: Any]]) -> Void in
        // Set Home Screen Quick Actions (3D Touch / Haptic Touch menu)
        DispatchQueue.main.async {
            var shortcutItems: [UIApplicationShortcutItem] = []
            
            // Limit to 4 items as per iOS guidelines
            let limitedItems = items.prefix(4)
            
            for item in limitedItems {
                guard let id = item["id"] as? String,
                      let name = item["name"] as? String else { continue }
                
                let type = "com.dmvieira.appacadabra.shortcut.run"
                let icon = UIApplicationShortcutIcon(type: .play) 
                
                let shortcut = UIApplicationShortcutItem(
                    type: type,
                    localizedTitle: name,
                    localizedSubtitle: nil,
                    icon: icon,
                    userInfo: ["appId": id as NSSecureCoding]
                )
                shortcutItems.append(shortcut)
            }
            
            UIApplication.shared.shortcutItems = shortcutItems
        }
    }

    AsyncFunction("launchApp") { (id: String) -> Void in
        // No-op on iOS for now
    }
  }
}