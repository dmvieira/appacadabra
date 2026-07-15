import Expo
import React
import ReactAppDependencyProvider
import BackgroundTasks

/// Task identifier matches `BGTaskSchedulerPermittedIdentifiers` in Info.plist
/// and the string used by `BackgroundGenerator.scheduleBackgroundProcessing`.
/// Any drift between these three sites causes iOS to crash the app at launch
/// (registration must exactly match the entitlement).
private let BG_GENERATE_TASK_ID = "ai.appacadabra.app.bg-generate"

/// Notification kicked from the BGProcessingTask handler; observed by
/// `BackgroundGenerator` which re-emits it to JS as a DeviceEventEmitter
/// event. Kept as a NotificationCenter hop so AppDelegate has no reference
/// to the RN bridge.
extension Notification.Name {
    static let bgReconcileRequest = Notification.Name("BGReconcileRequest")
}

@UIApplicationMain
public class AppDelegate: ExpoAppDelegate {
  var window: UIWindow?

  var reactNativeDelegate: ExpoReactNativeFactoryDelegate?
  var reactNativeFactory: RCTReactNativeFactory?

  public override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    // BGTaskScheduler MUST be registered before app finishes launching or
    // iOS crashes the process. Register even when the app is launched from
    // a tap (not from a BG event) — the handler simply won't fire until
    // the OS decides to.
    if #available(iOS 13.0, *) {
      BGTaskScheduler.shared.register(
        forTaskWithIdentifier: BG_GENERATE_TASK_ID,
        using: nil
      ) { task in
        AppDelegate.handleBackgroundProcessing(task)
      }
    }

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

  /// Opportunistic wake-up from iOS when BGProcessingTask fires. We do NOT
  /// drive the pipeline from here — instead we ping the JS layer to run
  /// `reconcilePendingJobs`, which discovers stale 'processing' rows and
  /// calls `bgGen.resume` on each. Resume opens a fresh
  /// `beginBackgroundTask` window (owned by BackgroundGenerator), so the
  /// spell-generation HTTP work continues under that token even after this
  /// BGProcessingTask completes.
  @available(iOS 13.0, *)
  private static func handleBackgroundProcessing(_ task: BGTask) {
    // Chain the next request. iOS treats submitted requests as hints — no
    // guarantee it fires, but keeping one queued keeps the door open.
    AppDelegate.scheduleNextBackgroundProcessing()

    task.expirationHandler = {
      task.setTaskCompleted(success: false)
    }

    NotificationCenter.default.post(name: .bgReconcileRequest, object: nil)

    // Give the JS side ~60s to receive the notification, start its own
    // `beginBackgroundTask` window via resume(), and get the first HTTP
    // round-trip going. The pipeline then continues under the JS-side
    // token independent of this BGProcessingTask's completion.
    DispatchQueue.main.asyncAfter(deadline: .now() + 60) {
      task.setTaskCompleted(success: true)
    }
  }

  /// Called from `didFinishLaunchingWithOptions` (best-effort keep-alive)
  /// and from `BackgroundGenerator.scheduleBackgroundProcessing` (when a
  /// spell generation starts). Idempotent — submitting the same identifier
  /// twice replaces the pending request rather than queueing a second one.
  @available(iOS 13.0, *)
  static func scheduleNextBackgroundProcessing() {
    let request = BGProcessingTaskRequest(identifier: BG_GENERATE_TASK_ID)
    request.requiresNetworkConnectivity = true
    request.requiresExternalPower = false
    // 15s is the minimum the OS enforces; anything sooner is silently
    // rounded up.
    request.earliestBeginDate = Date(timeIntervalSinceNow: 15)
    do {
      try BGTaskScheduler.shared.submit(request)
    } catch {
      // Common failures: identifier not in Info.plist, task already
      // scheduled, or app in a state that forbids submission. Non-fatal —
      // foreground-resume covers the deterministic path.
    }
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
