import Foundation
import Security

/// OpenRouter HTTP client for the iOS background executor.
///
/// This file contains only the *stateless* pieces: Keychain read, URL/header
/// construction, request-body serialization to a temp file (required by
/// `URLSessionUploadTask` when hosted on a background configuration), and
/// response parsing. The actual `URLSession.background` lifecycle lives in
/// `BackgroundGenerator.swift`, which owns the session, submits tasks, and
/// dispatches completions.
///
/// Keychain slot: read directly from the same slot `expo-secure-store` writes
/// to on the JS side (`lib/api/keyStorage.ts`). The key never crosses the JS
/// ↔ native bridge; native reads it lazily per request.
enum OpenRouterClient {
    static let baseURL = URL(string: "https://openrouter.ai/api/v1")!
    static let appReferrer = "https://appacadabra.ai"
    static let appTitle = "Appacadabra"

    // Must match `KEY_NAME` in lib/api/keyStorage.ts and the default
    // `SERVICE = "app"` used by expo-secure-store when no keychainService
    // option is passed. If either the JS side or expo-secure-store changes
    // the slot, this constant has to move in lockstep or the native code
    // will silently miss the user's key and fall back to unauthenticated
    // requests (which OpenRouter rejects with 401).
    static let keychainKey = "openrouter_api_key"
    static let keychainService = "app"

    // MARK: - Errors

    enum ClientError: Error, LocalizedError {
        case noKey
        case invalidKey
        case outOfCredit
        case rateLimited
        case upstream(status: Int, body: String)
        case network(String)
        case parse(String)
        case aborted

        /// Stable identifier that maps 1:1 to the JS-side `OpenRouterErrorCode`
        /// union. Passed back across the RN bridge so `store.ts` can render
        /// the same localized copy regardless of which platform failed.
        var code: String {
            switch self {
            case .noKey: return "byok.error.noKey"
            case .invalidKey: return "byok.error.invalidKey"
            case .outOfCredit: return "byok.error.outOfCredit"
            case .rateLimited: return "byok.error.rateLimited"
            case .upstream: return "byok.error.upstream"
            case .network: return "byok.error.network"
            case .parse: return "byok.error.parse"
            case .aborted: return "byok.error.aborted"
            }
        }

        var errorDescription: String? {
            switch self {
            case .noKey: return "OpenRouter key is not configured"
            case .invalidKey: return "OpenRouter rejected the key"
            case .outOfCredit: return "OpenRouter reports no remaining credit"
            case .rateLimited: return "OpenRouter rate-limited the request"
            case .upstream(let status, let body): return "OpenRouter upstream \(status): \(body.prefix(300))"
            case .network(let msg): return msg
            case .parse(let msg): return msg
            case .aborted: return "Request aborted"
            }
        }
    }

    // MARK: - Keychain

    /// Reads the user's OpenRouter key from the Keychain slot written by
    /// expo-secure-store. Returns nil when no key is stored or the item is
    /// present but unreadable (e.g. device locked, since we use
    /// `kSecAttrAccessibleWhenUnlocked`).
    static func readApiKey() -> String? {
        let accountData = Data(keychainKey.utf8)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: accountData,
            kSecAttrGeneric as String: accountData,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status == errSecSuccess, let data = item as? Data else {
            return nil
        }
        return String(data: data, encoding: .utf8)
    }

    // MARK: - Request building

    /// Builds a `URLRequest` for POST `/chat/completions`. Body is NOT set on
    /// the request itself — background upload tasks require a file URL as
    /// the source. Callers should hand `bodyFileURL` (from `writeBodyFile`)
    /// to `URLSession.uploadTask(with:fromFile:)`.
    static func makeChatRequest() throws -> URLRequest {
        guard let key = readApiKey() else {
            throw ClientError.noKey
        }
        let url = baseURL.appendingPathComponent("chat/completions")
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue(appReferrer, forHTTPHeaderField: "HTTP-Referer")
        req.setValue(appTitle, forHTTPHeaderField: "X-Title")
        req.setValue("true", forHTTPHeaderField: "X-OpenRouter-Cache")
        return req
    }

    /// Serializes an arbitrary JSON body to a temp file and returns its URL.
    /// Background upload tasks can't use `httpBody` (the daemon needs a file
    /// it can read after the app process exits), so every request goes
    /// through this. Cleanup is the caller's responsibility once the upload
    /// task has taken ownership.
    static func writeBodyFile(json body: [String: Any]) throws -> URL {
        let data = try JSONSerialization.data(withJSONObject: body, options: [])
        let tempDir = FileManager.default.temporaryDirectory
        let fileURL = tempDir.appendingPathComponent("or-\(UUID().uuidString).json")
        try data.write(to: fileURL, options: .atomic)
        return fileURL
    }

    // MARK: - Response parsing

    struct Usage: Codable {
        let promptTokens: Int
        let completionTokens: Int
        let totalTokens: Int
        let cost: Double?

        enum CodingKeys: String, CodingKey {
            case promptTokens = "prompt_tokens"
            case completionTokens = "completion_tokens"
            case totalTokens = "total_tokens"
            case cost
        }
    }

    struct ChatChoice: Codable {
        let index: Int
        let message: Message
        let finishReason: String?

        enum CodingKeys: String, CodingKey {
            case index, message
            case finishReason = "finish_reason"
        }

        struct Message: Codable {
            let role: String
            let content: String
        }
    }

    struct ChatResponse: Codable {
        let id: String
        let model: String
        let choices: [ChatChoice]
        let usage: Usage?
    }

    /// Parses a `/chat/completions` non-streaming response and maps upstream
    /// HTTP statuses to typed errors. `statusCode` is the HTTP status from
    /// the URLResponse; `data` is the raw response body.
    static func parseChatResponse(statusCode: Int, data: Data) throws -> ChatResponse {
        guard (200..<300).contains(statusCode) else {
            let snippet = String(data: data, encoding: .utf8) ?? ""
            switch statusCode {
            case 401, 403: throw ClientError.invalidKey
            case 402: throw ClientError.outOfCredit
            case 429: throw ClientError.rateLimited
            case 500...599: throw ClientError.upstream(status: statusCode, body: snippet)
            default: throw ClientError.upstream(status: statusCode, body: snippet)
            }
        }
        do {
            return try JSONDecoder().decode(ChatResponse.self, from: data)
        } catch {
            throw ClientError.parse("Failed to decode chat response: \(error.localizedDescription)")
        }
    }

    /// Extracts assistant text from the first choice, mirroring the JS
    /// `extractText(res)` helper. Returns nil if no content is present.
    static func extractText(_ res: ChatResponse) -> String? {
        guard let content = res.choices.first?.message.content, !content.isEmpty else {
            return nil
        }
        return content
    }
}
