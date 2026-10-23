package ai.appacadabra.app

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.wifi.WifiInfo
import android.os.Build
import android.os.Handler
import android.os.Looper
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * Informações de rede para o ritual de vínculo do Familiar: o SSID atual do
 * celular (para o app sugerir a rede correta em vez da rede antiga).
 *
 * O SSID exige permissão: NEARBY_WIFI_DEVICES (Android 13+) ou
 * ACCESS_FINE_LOCATION (<=12). Sem permissão, resolve `null`.
 */
class AppaNetModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    companion object {
        const val NAME = "AppaNetModule"
    }

    override fun getName() = NAME

    private fun hasWifiPermission(): Boolean {
        val ctx = reactApplicationContext.applicationContext
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            ctx.checkSelfPermission(Manifest.permission.NEARBY_WIFI_DEVICES) == PackageManager.PERMISSION_GRANTED
        } else {
            ctx.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
        }
    }

    @ReactMethod
    fun getWifiSsid(promise: Promise) {
        try {
            if (!hasWifiPermission()) {
                promise.reject("E_PERMISSION", "NEARBY_WIFI_DEVICES/ACCESS_FINE_LOCATION not granted")
                return
            }
            val ctx = reactApplicationContext.applicationContext
            val cm = ctx.getSystemService(ConnectivityManager::class.java)
            if (cm == null) {
                promise.resolve(null)
                return
            }
            // API moderna: TransportInfo do NetworkCallback entrega o WifiInfo
            // sem mascarar o SSID quando NEARBY_WIFI_DEVICES+neverForLocation.
            var settled = false
            val request = NetworkRequest.Builder().addTransportType(NetworkCapabilities.TRANSPORT_WIFI).build()
            val callback = object : ConnectivityManager.NetworkCallback() {
                override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) {
                    if (settled) return
                    settled = true
                    var ssid: String? = null
                    try {
                        val info = caps.transportInfo as? WifiInfo
                        ssid = info?.ssid?.removeSurrounding("\"")
                        if (ssid == "<unknown ssid>" || ssid.isNullOrEmpty()) ssid = null
                    } catch (e: Exception) {
                        ssid = null
                    }
                    runCatching { cm.unregisterNetworkCallback(this) }
                    promise.resolve(ssid)
                }
            }
            Handler(Looper.getMainLooper()).postDelayed({
                if (!settled) {
                    settled = true
                    runCatching { cm.unregisterNetworkCallback(callback) }
                    promise.resolve(null)
                }
            }, 3000)
            cm.requestNetwork(request, callback)
        } catch (e: Exception) {
            promise.reject("E_WIFI", e.message)
        }
    }
}
