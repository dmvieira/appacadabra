package ai.appacadabra.app

import android.util.Log
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.ServerSocket
import java.net.SocketTimeoutException

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableNativeMap

/**
 * Minimal HTTP server bound to the device loopback (127.0.0.1, ephemeral port),
 * used as the OAuth redirect target ("loopback redirect", RFC 8252 §7.3).
 *
 * Remote MCP servers like PicPay reject custom URI schemes at dynamic client
 * registration but accept loopback http — the same trick desktop clients
 * (Claude Code, opencode) use. The in-app browser tab shares the device's
 * network namespace, so a redirect to 127.0.0.1 reaches this server.
 *
 * JS API:
 *   start(): Promise<{ port }>          — binds the socket, stops previous instance
 *   waitForCallback(): Promise<string>  — resolves with the full callback URL
 *   stop(): Promise<boolean>            — releases the socket
 */
class LoopbackServerModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "LoopbackServerModule"

    private var server: ServerSocket? = null
    private var acceptThread: Thread? = null
    private var callbackPromise: Promise? = null
    private var boundPort: Int = -1

    @ReactMethod
    fun start(promise: Promise) {
        try {
            stopInternal()
            val socket = ServerSocket(0, 50, java.net.InetAddress.getByName("127.0.0.1"))
            socket.soTimeout = 500 // poll flag between accepts so stop() can interrupt
            server = socket
            boundPort = socket.localPort
            promise.resolve(WritableNativeMap().apply { putInt("port", boundPort) })
        } catch (e: Exception) {
            promise.reject("LOOPBACK_START_ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun waitForCallback(timeoutMs: Double, promise: Promise) {
        val socket = server
        if (socket == null || !socket.isBound) {
            promise.reject("LOOPBACK_NOT_RUNNING", "start() must be called first", null)
            return
        }
        callbackPromise = promise
        val deadline = System.currentTimeMillis() + timeoutMs.toLong()
        acceptThread = Thread {
            var current = socket
            try {
                while (callbackPromise === promise && !current.isClosed) {
                    if (System.currentTimeMillis() > deadline) {
                        rejectIfMatches(promise, "LOOPBACK_TIMEOUT", "No OAuth callback received in time", null)
                        return@Thread
                    }
                    val conn = try {
                        current.accept()
                    } catch (e: SocketTimeoutException) {
                        continue // poll flag; loop re-checks deadline/closed
                    }
                    conn.soTimeout = 5_000
                    try {
                        val reader = BufferedReader(InputStreamReader(conn.getInputStream(), Charsets.UTF_8))
                        val requestLine = reader.readLine() ?: ""
                        Log.d(TAG, "request: $requestLine")
                        // Drain remaining headers (Content-Length unknown for GETs; read till blank line).
                        var line = reader.readLine()
                        while (line != null && !line.isEmpty()) line = reader.readLine()

                        val target = requestLine.split(" ").getOrNull(1)
                        val isGet = requestLine.startsWith("GET ")
                        // OAuth authorization responses always carry `code` or
                        // `error` in the query. Accept any path — servers have
                        // been observed redirecting to paths other than the
                        // registered one, and this socket is single-purpose.
                        val isAuthResponse = isGet && target != null &&
                            (target.contains("code=") || target.contains("error="))
                        if (isGet && target != null && (target.startsWith("/callback") || isAuthResponse)) {
                            respond(conn, 200, CALLBACK_PAGE)
                            val url = "http://127.0.0.1:$boundPort$target"
                            Log.d(TAG, "callback received: $url")
                            resolveIfMatches(promise, url)
                            return@Thread
                        }
                        respond(conn, 404, "not found")
                        // Not the callback (favicon, probe) — keep listening.
                    } catch (e: Exception) {
                        Log.d(TAG, "request error: ${e.message}")
                        // Malformed request — keep listening.
                    } finally {
                        try { conn.close() } catch (_: Exception) {}
                    }
                }
            } catch (e: Exception) {
                // Socket closed by stop() — expected on cancellation.
                rejectIfMatches(promise, "LOOPBACK_CLOSED", e.message ?: "server stopped", e)
            }
        }
        acceptThread?.start()
    }

    @ReactMethod
    fun stop(promise: Promise) {
        try {
            stopInternal()
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("LOOPBACK_STOP_ERROR", e.message, e)
        }
    }

    private fun stopInternal() {
        try { acceptThread?.interrupt() } catch (_: Exception) {}
        acceptThread = null
        // Never leave a pending waitForCallback hanging across restarts/stops.
        callbackPromise?.let {
            try { it.reject("LOOPBACK_STOPPED", "Loopback server stopped", null) } catch (_: Exception) {}
        }
        callbackPromise = null
        try { server?.close() } catch (_: Exception) {}
        server = null
        boundPort = -1
    }

    private fun rejectIfMatches(p: Promise, code: String, message: String, e: Exception?) {
        synchronized(this) {
            if (callbackPromise === p) {
                callbackPromise = null
                p.reject(code, message, e)
            }
        }
    }

    private fun resolveIfMatches(p: Promise, url: String) {
        synchronized(this) {
            if (callbackPromise === p) {
                callbackPromise = null
                p.resolve(url)
            }
        }
    }

    private fun respond(conn: java.net.Socket, status: Int, body: String) {
        val reason = if (status == 200) "OK" else "Not Found"
        val payload = body.toByteArray(Charsets.UTF_8)
        conn.getOutputStream().apply {
            write("HTTP/1.1 $status $reason\r\n".toByteArray())
            write("Content-Type: text/html; charset=utf-8\r\n".toByteArray())
            write("Content-Length: ${payload.size}\r\n".toByteArray())
            write("Connection: close\r\n\r\n".toByteArray())
            write(payload)
            flush()
        }
    }

    override fun invalidate() {
        stopInternal()
        super.invalidate()
    }

    companion object {
        private const val TAG = "McpLoopback"

        // OAuth interstitial shown in the Custom Tab after the redirect lands.
        // Locale-picked client-side (the tab shares the device language).
        private const val CALLBACK_PAGE =
            "<!DOCTYPE html><html><head><meta charset=\"utf-8\">" +
            "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">" +
            "<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;" +
            "background:#0A0A1A;color:#EDEDF5;font-family:sans-serif;text-align:center}" +
            "h1{font-size:20px}</style></head>" +
            "<body><div><h1 id=\"t\"></h1></div>" +
            "<script>var m={en:'\uD83E\uDE84 You can return to Appacadabra',pt:'\uD83E\uDE84 Pode voltar ao Appacadabra',es:'\uD83E\uDE84 Puedes volver a Appacadabra'};" +
            "var l=(navigator.language||'en').slice(0,2);" +
            "document.getElementById('t').textContent=m[l]||m.en;</script></body></html>"
    }
}
