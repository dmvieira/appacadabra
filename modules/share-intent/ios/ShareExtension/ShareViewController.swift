import UIKit
import Social
import MobileCoreServices
import UniformTypeIdentifiers

// Entry point for the iOS Share Extension. Runs in a separate process from the
// host app; the only IPC channel is the shared App Group container
// (UserDefaults suite + file container) declared in this target's entitlements.
//
// Keys written here MUST match exactly what `modules/share-intent/ios/ShareIntentModule.swift`
// reads inside the main app:
//   - sharedText           (String)
//   - sharedUrl            (String)
//   - sharedFileUri        (String, file:// URL absoluteString)
//   - sharedFileMimeType   (String)
//   - sharedMimeType       (String, optional companion to sharedText/sharedUrl)
class ShareViewController: UIViewController {
    let appGroupId = "group.ai.appacadabra.app"

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        handleSharedContent()
    }

    private func handleSharedContent() {
        guard let extensionItem = extensionContext?.inputItems.first as? NSExtensionItem,
              let attachments = extensionItem.attachments else {
            extensionContext?.completeRequest(returningItems: nil, completionHandler: nil)
            return
        }

        let group = DispatchGroup()
        var sharedText: String? = nil
        var sharedUrl: String? = nil
        var sharedFileUri: String? = nil
        var sharedFileMimeType: String? = nil

        for attachment in attachments {
            // Order matters: prefer file-url before plain url, and url before plain
            // text, because some hosts attach multiple representations.
            if attachment.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
                group.enter()
                attachment.loadFileRepresentation(forTypeIdentifier: UTType.fileURL.identifier) { url, _ in
                    defer { group.leave() }
                    guard let sourceUrl = url,
                          let containerURL = FileManager.default.containerURL(
                            forSecurityApplicationGroupIdentifier: self.appGroupId
                          ) else { return }

                    let sharedDir = containerURL.appendingPathComponent("SharedFiles", isDirectory: true)
                    try? FileManager.default.createDirectory(at: sharedDir, withIntermediateDirectories: true)

                    let destUrl = sharedDir.appendingPathComponent(
                        "\(Int(Date().timeIntervalSince1970 * 1000))_\(sourceUrl.lastPathComponent)"
                    )

                    do {
                        if FileManager.default.fileExists(atPath: destUrl.path) {
                            try FileManager.default.removeItem(at: destUrl)
                        }
                        try FileManager.default.copyItem(at: sourceUrl, to: destUrl)
                        sharedFileUri = destUrl.absoluteString
                        sharedFileMimeType = Self.mimeType(forExtension: destUrl.pathExtension)
                    } catch {
                        // Best-effort copy; if it fails leave the slot empty so the
                        // main app simply sees no shared file.
                    }
                }
            } else if attachment.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
                group.enter()
                attachment.loadItem(forTypeIdentifier: UTType.url.identifier, options: nil) { item, _ in
                    defer { group.leave() }
                    if let url = item as? URL {
                        sharedUrl = url.absoluteString
                    } else if let urlString = item as? String {
                        sharedUrl = urlString
                    }
                }
            } else if attachment.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
                group.enter()
                attachment.loadItem(forTypeIdentifier: UTType.plainText.identifier, options: nil) { item, _ in
                    defer { group.leave() }
                    if let text = item as? String {
                        sharedText = text
                    } else if let data = item as? Data, let text = String(data: data, encoding: .utf8) {
                        sharedText = text
                    }
                }
            }
        }

        group.notify(queue: .main) {
            self.persistAndComplete(
                text: sharedText,
                url: sharedUrl,
                fileUri: sharedFileUri,
                fileMime: sharedFileMimeType
            )
        }
    }

    private func persistAndComplete(text: String?, url: String?, fileUri: String?, fileMime: String?) {
        if let defaults = UserDefaults(suiteName: appGroupId) {
            // Clear stale slots so a new share never resurrects an older value.
            defaults.removeObject(forKey: "sharedText")
            defaults.removeObject(forKey: "sharedUrl")
            defaults.removeObject(forKey: "sharedFileUri")
            defaults.removeObject(forKey: "sharedFileMimeType")
            defaults.removeObject(forKey: "sharedMimeType")

            if let text = text {
                defaults.set(text, forKey: "sharedText")
                defaults.set("text/plain", forKey: "sharedMimeType")
            }
            if let url = url {
                defaults.set(url, forKey: "sharedUrl")
                if text == nil {
                    defaults.set("text/uri-list", forKey: "sharedMimeType")
                }
            }
            if let fileUri = fileUri {
                defaults.set(fileUri, forKey: "sharedFileUri")
                defaults.set(fileMime ?? "application/octet-stream", forKey: "sharedFileMimeType")
            }
        }

        // Wake the main app. Extensions cannot call `UIApplication.shared.open`
        // directly (the symbol is unavailable in extension contexts), so we walk
        // the UIResponder chain looking for an object that responds to
        // `openURL:` — which is the runtime selector backing `open(_:options:completionHandler:)`
        // on UIApplication. This is the Apple-sanctioned workaround used by most
        // open-source share extensions; it has shipped on the App Store for years.
        if let wakeUrl = URL(string: "appacadabra://share-received") {
            openURLFromExtension(wakeUrl)
        }

        extensionContext?.completeRequest(returningItems: nil, completionHandler: nil)
    }

    @discardableResult
    private func openURLFromExtension(_ url: URL) -> Bool {
        var responder: UIResponder? = self
        let selector = sel_registerName("openURL:")
        while let current = responder {
            if current.responds(to: selector) && !(current is ShareViewController) {
                _ = current.perform(selector, with: url)
                return true
            }
            responder = current.next
        }
        return false
    }

    private static func mimeType(forExtension ext: String) -> String {
        guard !ext.isEmpty else { return "application/octet-stream" }
        if let type = UTType(filenameExtension: ext),
           let mime = type.preferredMIMEType {
            return mime
        }
        return "application/octet-stream"
    }
}
