import Expo
import React
import ReactAppDependencyProvider

@UIApplicationMain
public class AppDelegate: ExpoAppDelegate {
  var window: UIWindow?

  var reactNativeDelegate: ExpoReactNativeFactoryDelegate?
  var reactNativeFactory: RCTReactNativeFactory?

  public override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    let delegate = ReactNativeDelegate()
    let factory = ExpoReactNativeFactory(delegate: delegate)
    delegate.dependencyProvider = RCTAppDependencyProvider()

    reactNativeDelegate = delegate
    reactNativeFactory = factory
    bindReactNativeFactory(factory)

#if os(iOS) || os(tvOS)
    window = UIWindow(frame: UIScreen.main.bounds)
    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: launchOptions)
#endif

    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  // Linking API
  public override func application(
    _ app: UIApplication,
    open url: URL,
    options: [UIApplication.OpenURLOptionsKey: Any] = [:]
  ) -> Bool {
    return super.application(app, open: url, options: options) || RCTLinkingManager.application(app, open: url, options: options)
  }

  // Universal Links
  public override func application(
    _ application: UIApplication,
    continue userActivity: NSUserActivity,
    restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void
  ) -> Bool {
    if userActivity.activityType == "ai.appacadabra.app.run",
       let appId = userActivity.userInfo?["appId"] as? String,
       let url = URL(string: "appacadabra://runner/\(appId)") {
        return RCTLinkingManager.application(application, open: url, options: [:])
    }

    let result = RCTLinkingManager.application(application, continue: userActivity, restorationHandler: restorationHandler)
    return super.application(application, continue: userActivity, restorationHandler: restorationHandler) || result
  }

  // Quick Actions (3D Touch / Haptic Touch)
  public override func application(
    _ application: UIApplication,
    performActionFor shortcutItem: UIApplicationShortcutItem,
    completionHandler: @escaping (Bool) -> Void
  ) {
    if let appId = shortcutItem.userInfo?["appId"] as? String,
       let url = URL(string: "appacadabra://runner/\(appId)") {
        RCTLinkingManager.application(application, open: url, options: [:])
    }
    completionHandler(true)
  }

  // URLSession background completion — invoked by iOS when the system
  // relaunches the app to hand off events from a background URLSession
  // (see BackgroundGenerator.swift). We stash the OS-provided completion
  // handler on `BackgroundURLSessionRegistry`; the URLSession delegate
  // pulls it and calls it once all pending events have been processed,
  // signalling the OS that it's safe to suspend us again.
  //
  // No-op today because the Swift executor currently uses
  // `beginBackgroundTask` instead of a background URLSession. Wiring the
  // hook now means the future kill-survival path doesn't need to touch
  // `AppDelegate` — swap in URLSession.background inside the module and
  // it just works.
  public override func application(
    _ application: UIApplication,
    handleEventsForBackgroundURLSession identifier: String,
    completionHandler: @escaping () -> Void
  ) {
    BackgroundURLSessionRegistry.shared.register(identifier: identifier, handler: completionHandler)
  }
}

/// Holds URLSession-background completion handlers keyed by session
/// identifier. The URLSession delegate (added by the future kill-survival
/// pipeline) pulls the handler out via `consume(identifier:)` and invokes
/// it from `urlSessionDidFinishEvents(forBackgroundURLSession:)`.
final class BackgroundURLSessionRegistry {
    static let shared = BackgroundURLSessionRegistry()

    private var handlers: [String: () -> Void] = [:]
    private let lock = NSLock()

    private init() {}

    func register(identifier: String, handler: @escaping () -> Void) {
        lock.lock(); defer { lock.unlock() }
        handlers[identifier] = handler
    }

    func consume(identifier: String) -> (() -> Void)? {
        lock.lock(); defer { lock.unlock() }
        return handlers.removeValue(forKey: identifier)
    }
}

class ReactNativeDelegate: ExpoReactNativeFactoryDelegate {
  // Extension point for config-plugins

  override func sourceURL(for bridge: RCTBridge) -> URL? {
    // needed to return the correct URL for expo-dev-client.
    bridge.bundleURL ?? bundleURL()
  }

  override func bundleURL() -> URL? {
#if DEBUG
    return RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: ".expo/.virtual-metro-entry")
#else
    return Bundle.main.url(forResource: "main", withExtension: "jsbundle")
#endif
  }
}
