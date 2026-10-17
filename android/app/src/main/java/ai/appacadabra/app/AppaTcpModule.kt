package ai.appacadabra.app

import android.util.Base64
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.io.IOException
import java.io.OutputStream
import java.net.InetSocketAddress
import java.net.Socket

/**
 * Dev/QA transport for appa devices: plain TCP against appa-sim.
 * The production transport is BLE (AppaBleModule); the framing layer lives
 * entirely in TypeScript (lib/devices/protocol.ts), so this module only moves
 * bytes: connect/write(base64)/disconnect + AppaTcpData events.
 */
class AppaTcpModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    companion object {
        const val NAME = "AppaTcpModule"
    }

    private var socket: Socket? = null
    private var output: OutputStream? = null
    private var readThread: Thread? = null

    override fun getName() = NAME

    @ReactMethod
    fun connect(host: String, port: Int, promise: Promise) {
        disconnect()
        try {
            val s = Socket()
            s.connect(InetSocketAddress(host, port), 5000)
            s.soTimeout = 0
            socket = s
            output = s.getOutputStream()
            readLoop(s)
            promise.resolve(null)
        } catch (e: Exception) {
            socket = null
            output = null
            promise.reject("E_CONNECT", e.message ?: "connect failed", e)
        }
    }

    private fun readLoop(s: Socket) {
        val ctx = reactApplicationContext
        readThread = Thread {
            try {
                val buf = ByteArray(4096)
                val input = s.getInputStream()
                while (!s.isClosed) {
                    val n = input.read(buf)
                    if (n < 0) break
                    val b64 = Base64.encodeToString(buf.copyOf(n), Base64.NO_WRAP)
                    val params = Arguments.createMap().apply { putString("base64", b64) }
                    ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                        .emit("AppaTcpData", params)
                }
            } catch (_: IOException) {
                // socket closed
            } finally {
                ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                    .emit("AppaTcpDisconnect", null)
            }
        }.also { it.start() }
    }

    @ReactMethod
    fun write(b64: String, promise: Promise) {
        try {
            val out = output ?: throw IOException("not connected")
            out.write(Base64.decode(b64, Base64.NO_WRAP))
            out.flush()
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("E_WRITE", e.message ?: "write failed", e)
        }
    }

    @ReactMethod
    fun disconnect() {
        try {
            socket?.close()
        } catch (_: IOException) {
        }
        socket = null
        output = null
        readThread = null
    }

    @ReactMethod
    fun addListener(eventName: String) {
        // Required for RN event emitter (no-op)
    }

    @ReactMethod
    fun removeListeners(count: Int) {
        // Required for RN event emitter (no-op)
    }

    override fun onCatalystInstanceDestroy() {
        disconnect()
    }
}
