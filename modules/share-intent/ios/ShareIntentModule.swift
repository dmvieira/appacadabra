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
        
        // Example structure matching the JS type
        // mimeType: string;
        // uri?: string;
        // text?: string;
        
        if let sharedText = userDefaults.string(forKey: "sharedText") {
             return [
                "mimeType": "text/plain",
                "text": sharedText
             ]
        }
        
        if let sharedUrl = userDefaults.string(forKey: "sharedUrl") {
            return [
                "mimeType": "text/plain",
                "text": sharedUrl
            ]
        }
        
        return nil
    }

    Function("clearSharedContent") {
        guard let userDefaults = UserDefaults(suiteName: self.appGroupId) else {
            return
        }
        userDefaults.removeObject(forKey: "sharedText")
        userDefaults.removeObject(forKey: "sharedUrl")
        // Clean up other keys as needed
    }

    Function("checkShareIntent") {
        guard let userDefaults = UserDefaults(suiteName: self.appGroupId) else {
            return
        }
        
        if let sharedText = userDefaults.string(forKey: "sharedText") {
             self.sendEvent("onShareReceived", [
                "mimeType": "text/plain",
                "text": sharedText
             ])
        }
    }
    
    Function("markAsProcessed") {
        // No-op for now or same as clear
        guard let userDefaults = UserDefaults(suiteName: self.appGroupId) else {
            return
        }
        userDefaults.removeObject(forKey: "sharedText")
        userDefaults.removeObject(forKey: "sharedUrl")
    }

    // iOS Stubs for Android-specific Activity logic
    AsyncFunction("startRunnerActivity") { (appId: Int) -> Bool in
        return false // Not supported directly on iOS
    }

    AsyncFunction("openRunnerWindow") { (appId: Int) -> Bool in
        return false // Not supported directly on iOS
    }

    AsyncFunction("finishRunnerActivity") { (appId: Int) -> Bool in
        return true
    }
  }
}
