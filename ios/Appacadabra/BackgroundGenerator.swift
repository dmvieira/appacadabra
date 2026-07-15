import Foundation
import UIKit
import React
import BackgroundTasks

/// iOS bridge for the background spell-generation pipeline.
///
/// Scope of this file (Phase 2 v1):
///   - Mirrors the Android `BackgroundGeneratorModule` bridge surface
///     (`startCreate` / `startEdit` / `cancel` / `status`) so `store.ts`
///     hits one API on both platforms.
///   - Extends the app's background execution window via
///     `UIApplication.beginBackgroundTask` so a foregrounded generation
///     keeps running for the full OS-granted background window (~30 s)
///     after the user backgrounds the app — instead of the ~5 s default.
///   - The actual pipeline runs in the JS thread via the in-process
///     fallback in `lib/backgroundGenerator.ts`; JS calls `endJob` from
///     its completion/failure handlers to release the background token.
///
/// **Not in this file yet — deferred to a future phase:**
///   - Full swipe-kill survival via `URLSessionConfiguration.background`.
///     That requires porting `generatorStages` orchestration to Swift
///     (validators can still round-trip to JS) plus wiring
///     `handleEventsForBackgroundURLSession` in `AppDelegate` to relaunch
///     the JS bridge after kill. Tracked as a separate initiative — this
///     module is written so that future work can extend it without
///     rebuilding the bridge surface.
@objc(BackgroundGenerator)
class BackgroundGenerator: RCTEventEmitter {
    private var activeJobs: [String: UIBackgroundTaskIdentifier] = [:]
    private let queue = DispatchQueue(label: "ai.appacadabra.bggen", attributes: .concurrent)

    override init() {
        super.init()
        // Bridge from AppDelegate's BGProcessingTask handler (fired by iOS
        // opportunistically when the app is backgrounded) into the JS layer
        // so `reconcilePendingJobs` can find stale rows and resume them.
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(onReconcileRequest),
            name: Notification.Name("BGReconcileRequest"),
            object: nil
        )
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

    override static func requiresMainQueueSetup() -> Bool {
        return false
    }

    override func supportedEvents() -> [String]! {
        // Kept in sync with EVENT_* constants in lib/backgroundGenerator.ts.
        // We don't emit BGGen* from Swift today (JS emits them itself via
        // DeviceEventEmitter in the in-process fallback), but declaring
        // them here lets a future Swift-driven pipeline post the same
        // channel without a JS-side change.
        //
        // BGReconcileRequest is emitted from `onReconcileRequest` below when
        // AppDelegate's BGProcessingTask handler fires. JS subscribes in
        // app/_layout.tsx.
        return ["BGGenProgress", "BGGenCompleted", "BGGenFailed", "BGReconcileRequest"]
    }

    @objc private func onReconcileRequest() {
        // RCTEventEmitter.sendEvent silently drops the event when there are
        // no active listeners — safe to call whether or not the RN bridge
        // is fully spun up yet.
        sendEvent(withName: "BGReconcileRequest", body: [:])
    }

    // MARK: - Bridge methods

    @objc(startCreate:resolver:rejecter:)
    func startCreate(
        _ params: NSDictionary,
        resolver resolve: @escaping RCTPromiseResolveBlock,
        rejecter reject: @escaping RCTPromiseRejectBlock
    ) {
        guard let jobId = params["jobId"] as? String, !jobId.isEmpty else {
            reject("BG_GEN_ARGS", "jobId is required", nil)
            return
        }
        beginJob(jobId: jobId, name: "spell.create.\(jobId)")
        resolve(nil)
    }

    @objc(startEdit:resolver:rejecter:)
    func startEdit(
        _ params: NSDictionary,
        resolver resolve: @escaping RCTPromiseResolveBlock,
        rejecter reject: @escaping RCTPromiseRejectBlock
    ) {
        guard let jobId = params["jobId"] as? String, !jobId.isEmpty else {
            reject("BG_GEN_ARGS", "jobId is required", nil)
            return
        }
        beginJob(jobId: jobId, name: "spell.edit.\(jobId)")
        resolve(nil)
    }

    /// Called by `lib/backgroundGenerator.ts` from both the completion and
    /// failure handlers of the in-process fallback. Idempotent so a
    /// double-call (e.g. race between success emit and cancel) doesn't
    /// crash.
    @objc(endJob:resolver:rejecter:)
    func endJob(
        _ jobId: String,
        resolver resolve: @escaping RCTPromiseResolveBlock,
        rejecter reject: @escaping RCTPromiseRejectBlock
    ) {
        releaseJob(jobId: jobId)
        resolve(nil)
    }

    @objc(cancel:resolver:rejecter:)
    func cancel(
        _ jobId: String,
        resolver resolve: @escaping RCTPromiseResolveBlock,
        rejecter reject: @escaping RCTPromiseRejectBlock
    ) {
        // JS pipeline has no cancellation hook today (see note in
        // lib/backgroundGenerator.ts). We just release the background
        // token so we don't hold it after cancellation; the fetch itself
        // finishes on its own timeline.
        releaseJob(jobId: jobId)
        resolve(nil)
    }

    @objc(status:resolver:rejecter:)
    func status(
        _ jobId: String,
        resolver resolve: @escaping RCTPromiseResolveBlock,
        rejecter reject: @escaping RCTPromiseRejectBlock
    ) {
        var running = false
        queue.sync {
            running = activeJobs[jobId] != nil
        }
        if running {
            resolve(["state": "running", "stage": "planner", "attempt": 0])
        } else {
            resolve(["state": "not-found"])
        }
    }

    /// Ask iOS to schedule a `BGProcessingTaskRequest` for opportunistic
    /// wake-up while backgrounded. Called from JS whenever a spell
    /// generation is running and the app transitions to background. iOS
    /// decides when (or whether) to fire the handler; the deterministic
    /// path is foreground-resume via `reconcilePendingJobs`. Idempotent —
    /// re-submitting the same identifier replaces the pending request.
    @objc(scheduleBackgroundProcessing:rejecter:)
    func scheduleBackgroundProcessing(
        _ resolve: @escaping RCTPromiseResolveBlock,
        rejecter reject: @escaping RCTPromiseRejectBlock
    ) {
        if #available(iOS 13.0, *) {
            AppDelegate.scheduleNextBackgroundProcessing()
        }
        resolve(nil)
    }

    // MARK: - Background task lifecycle

    private func beginJob(jobId: String, name: String) {
        let app = UIApplication.shared
        var taskId: UIBackgroundTaskIdentifier = .invalid
        taskId = app.beginBackgroundTask(withName: name) { [weak self] in
            // Called by the OS when we're about to run out of background
            // time. We just release — the JS side sees the fetch abort or
            // the app returning to foreground and reports failure through
            // the normal reconciliation path (see reconcilePendingJobs).
            self?.releaseJob(jobId: jobId)
        }
        queue.async(flags: .barrier) {
            self.activeJobs[jobId] = taskId
        }
    }

    private func releaseJob(jobId: String) {
        var taskId: UIBackgroundTaskIdentifier = .invalid
        queue.sync(flags: .barrier) {
            if let existing = self.activeJobs.removeValue(forKey: jobId) {
                taskId = existing
            }
        }
        if taskId != .invalid {
            UIApplication.shared.endBackgroundTask(taskId)
        }
    }
}
