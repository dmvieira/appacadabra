package ai.appacadabra.app

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.net.wifi.WifiManager
import android.os.Build
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
            val wm = ctx.getSystemService(Context.WIFI_SERVICE) as? WifiManager
            val raw = wm?.connectionInfo?.ssid
            if (raw == null || raw == "<unknown ssid>" || raw.isEmpty()) {
                promise.resolve(null)
                return
            }
            promise.resolve(raw.trim('"'))
        } catch (e: Throwable) {
            promise.reject("E_WIFI", e.message ?: e.toString())
        }
    }
}
