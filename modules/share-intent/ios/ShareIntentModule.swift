import ExpoModulesCore
import Foundation

public class ShareIntentModule: Module {
  let appGroupId = "group.ai.appacadabra.app"

  public func definition() -> ModuleDefinition {
    Name("ShareIntent")

    Events("onShareReceived")

    Function("getSharedContent") { () -> [String: Any]? in
        guard let userDefaults = UserDefaults(suiteName: self.appGroupId) else {
            return nil
        }

        if let sharedText = userDefaults.string(forKey: "sharedText") {
             return ["mimeType": "text/plain", "text": sharedText]
        }

        if let sharedUrl = userDefaults.string(forKey: "sharedUrl") {
            return ["mimeType": "text/plain", "text": sharedUrl]
        }

        if let fileUri = userDefaults.string(forKey: "sharedFileUri"),
           let mimeType = userDefaults.string(forKey: "sharedFileMimeType") {
            return ["mimeType": mimeType, "uri": fileUri]
        }

        return nil
    }

    Function("clearSharedContent") {
        guard let userDefaults = UserDefaults(suiteName: self.appGroupId) else { return }
        userDefaults.removeObject(forKey: "sharedText")
        userDefaults.removeObject(forKey: "sharedUrl")
        userDefaults.removeObject(forKey: "sharedFileUri")
        userDefaults.removeObject(forKey: "sharedFileMimeType")
    }

    Function("checkShareIntent") {
        guard let userDefaults = UserDefaults(suiteName: self.appGroupId) else { return }

        if let sharedText = userDefaults.string(forKey: "sharedText") {
             self.sendEvent("onShareReceived", ["mimeType": "text/plain", "text": sharedText])
        } else if let sharedUrl = userDefaults.string(forKey: "sharedUrl") {
            self.sendEvent("onShareReceived", ["mimeType": "text/plain", "text": sharedUrl])
        } else if let fileUri = userDefaults.string(forKey: "sharedFileUri"),
                  let mimeType = userDefaults.string(forKey: "sharedFileMimeType") {
            self.sendEvent("onShareReceived", ["mimeType": mimeType, "uri": fileUri])
        }
    }

    Function("markAsProcessed") {
        guard let userDefaults = UserDefaults(suiteName: self.appGroupId) else { return }
        userDefaults.removeObject(forKey: "sharedText")
        userDefaults.removeObject(forKey: "sharedUrl")
        userDefaults.removeObject(forKey: "sharedFileUri")
        userDefaults.removeObject(forKey: "sharedFileMimeType")
    }

    // iOS stubs for Android-specific Activity logic
    AsyncFunction("startRunnerActivity") { (appId: Int) -> Bool in
        return false
    }

    AsyncFunction("openRunnerWindow") { (appId: Int) -> Bool in
        return false
    }

    AsyncFunction("finishRunnerActivity") { (appId: Int) -> Bool in
        return true
    }
  }
}
