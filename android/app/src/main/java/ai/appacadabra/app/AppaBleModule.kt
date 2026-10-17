package ai.appacadabra.app

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanResult
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.util.Base64
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.util.UUID
import java.util.concurrent.ConcurrentLinkedQueue

/**
 * BLE NUS (Nordic UART Service) central — the production transport for appa
 * Familiars. Deliberately minimal contract so the iOS twin (CoreBluetooth:
 * CBCentralManager scan/connect + characteristic write/notify) is a direct
 * mirror; ALL protocol logic (framing, CRC, envelope) lives in TypeScript.
 *
 * JS contract (AppaBleModule):
 *   scan(timeoutMs)                  -> resolves with [{id, name, rssi}] (also AppaBleDevice events)
 *   stopScan()
 *   connect(deviceId)                -> resolves when NUS notify is on (AppaBleConnected)
 *   write(base64)                    -> chunked by MTU-3 over NUS RX
 *   disconnect()                     -> AppaBleDisconnect event
 *   data events: AppaBleData {base64}
 *
 * Permissions: BLUETOOTH_SCAN/BLUETOOTH_CONNECT (S+) must be requested by the
 * JS side before scan()/connect() — this module rejects with E_PERMISSION.
 */
@SuppressLint("MissingPermission")
class AppaBleModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    companion object {
        const val NAME = "AppaBleModule"
        val NUS_SERVICE: UUID = UUID.fromString("6e400001-b5a3-f393-e0a9-e50e24dcca9e")
        val NUS_RX: UUID = UUID.fromString("6e400002-b5a3-f393-e0a9-e50e24dcca9e") // app -> device
        val NUS_TX: UUID = UUID.fromString("6e400003-b5a3-f393-e0a9-e50e24dcca9e") // device -> app
        const val CCC_DESCRIPTOR: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")
        const val CHUNK = 180 // conservative until MTU is known
    }

    private var adapterCache: BluetoothAdapter? = null

    private fun adapter(): BluetoothAdapter? {
        if (adapterCache == null) {
            adapterCache =
                reactApplicationContext.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothAdapter
        }
        return adapterCache
    }

    private var scanning = false
    private val found = LinkedHashMap<String, Map<String, Any>>()
    private var scanPromise: Promise? = null

    private var gatt: BluetoothGatt? = null
    private var rxChar: BluetoothGattCharacteristic? = null
    private var txChar: BluetoothGattCharacteristic? = null
    private var connectPromise: Promise? = null
    private var writeQueue = ConcurrentLinkedQueue<ByteArray>()
    private var writing = false

    override fun getName() = NAME

    private fun hasPermission(): Boolean =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            ContextCompat.checkSelfPermission(reactApplicationContext, Manifest.permission.BLUETOOTH_SCAN) ==
                PackageManager.PERMISSION_GRANTED &&
                ContextCompat.checkSelfPermission(reactApplicationContext, Manifest.permission.BLUETOOTH_CONNECT) ==
                PackageManager.PERMISSION_GRANTED
        } else true

    private fun emit(event: String, params: com.facebook.react.bridge.WritableMap?) {
        reactApplicationContext.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit(event, params)
    }

    // ---- scan ---------------------------------------------------------------

    private val scanCallback = object : ScanCallback() {
        override fun onScanResult(callbackType: Int, result: ScanResult) {
            val device: BluetoothDevice = result.device
            val name = device.name ?: result.scanRecord?.deviceName ?: return
            val entry = mapOf("id" to device.address, "name" to name, "rssi" to result.rssi)
            val prev = found[device.address]
            if (prev != null && prev["name"] == name) return
            found[device.address] = entry
            val params = Arguments.createMap().apply {
                putString("id", device.address)
                putString("name", name)
                putInt("rssi", result.rssi)
            }
            emit("AppaBleDevice", params)
        }

        override fun onScanFailed(errorCode: Int) {
            scanning = false
            scanPromise?.reject("E_SCAN", "scan failed: $errorCode")
            scanPromise = null
        }
    }

    @ReactMethod
    fun scan(timeoutMs: Int, promise: Promise) {
        if (!hasPermission()) {
            promise.reject("E_PERMISSION", "BLUETOOTH_SCAN/BLUETOOTH_CONNECT not granted")
            return
        }
        stopScanInternal()
        found.clear()
        scanPromise = promise
        val scanner = adapter()?.bluetoothLeScanner
        if (scanner == null) {
            scanPromise = null
            promise.reject("E_NO_ADAPTER", "no BLE adapter")
            return
        }
        scanning = true
        scanner.startScan(null, null, scanCallback)
        Thread {
            try {
                Thread.sleep(timeoutMs.toLong())
            } catch (_: InterruptedException) {
            }
            stopScanInternal()
            val list = Arguments.createArray()
            for (entry in found.values) {
                list.pushMap(Arguments.createMap().apply {
                    putString("id", entry["id"] as String)
                    putString("name", entry["name"] as String)
                    putInt("rssi", (entry["rssi"] as Int))
                })
            }
            promise.resolve(list)
        }.start()
    }

    @ReactMethod
    fun stopScan() {
        stopScanInternal()
    }

    private fun stopScanInternal() {
        if (scanning) {
            try {
                adapter()?.bluetoothLeScanner?.stopScan(scanCallback)
            } catch (_: Exception) {
            }
            scanning = false
        }
    }

    // ---- connect (NUS) --------------------------------------------------------

    private val gattCallback = object : BluetoothGattCallback() {
        override fun onConnectionStateChange(g: BluetoothGatt, status: Int, newState: Int) {
            if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                gatt = null
                rxChar = null
                txChar = null
                connectPromise?.reject("E_DISCONNECTED", "disconnected (status $status)")
                connectPromise = null
                emit("AppaBleDisconnect", null)
                try {
                    g.close()
                } catch (_: Exception) {
                }
            }
        }

        override fun onServicesDiscovered(g: BluetoothGatt, status: Int) {
            if (status != BluetoothGatt.GATT_SUCCESS) {
                connectPromise?.reject("E_SERVICES", "service discovery failed: $status")
                connectPromise = null
                return
            }
            val service = g.getService(NUS_SERVICE)
            if (service == null) {
                connectPromise?.reject("E_NO_NUS", "device does not expose NUS")
                connectPromise = null
                g.disconnect()
                return
            }
            rxChar = service.getCharacteristic(NUS_RX)
            txChar = service.getCharacteristic(NUS_TX)
            if (rxChar == null || txChar == null) {
                connectPromise?.reject("E_NO_NUS", "NUS characteristics missing")
                connectPromise = null
                g.disconnect()
                return
            }
            g.requestMtu(247)
        }

        override fun onMtuChanged(g: BluetoothGatt, mtu: Int, status: Int) {
            // Enable TX notifications (device -> app)
            g.setCharacteristicNotification(txChar, true)
            val descriptor = txChar.getDescriptor(CCC_DESCRIPTOR)
            if (descriptor != null) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    g.writeDescriptor(descriptor, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE)
                } else {
                    @Suppress("DEPRECATION")
                    descriptor.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
                    @Suppress("DEPRECATION")
                    g.writeDescriptor(descriptor)
                }
            }
        }

        override fun onDescriptorWrite(g: BluetoothGatt, descriptor: BluetoothGattDescriptor, status: Int) {
            if (descriptor.uuid == CCC_DESCRIPTOR) {
                connectPromise?.resolve(null)
                connectPromise = null
                emit("AppaBleConnected", null)
            }
        }

        override fun onCharacteristicChanged(
            g: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
            value: ByteArray,
        ) {
            if (characteristic.uuid == NUS_TX) {
                val b64 = Base64.encodeToString(value, Base64.NO_WRAP)
                val params = Arguments.createMap().apply { putString("base64", b64) }
                emit("AppaBleData", params)
            }
        }

        @Deprecated("pre-T callback")
        @Suppress("DEPRECATION", "OVERRIDE_DEPRECATION")
        override fun onCharacteristicChanged(g: BluetoothGatt, characteristic: BluetoothGattCharacteristic) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
                @Suppress("DEPRECATION")
                val value = characteristic.value ?: return
                onCharacteristicChanged(g, characteristic, value)
            }
        }

        override fun onCharacteristicWrite(g: BluetoothGatt, characteristic: BluetoothGattCharacteristic, status: Int) {
            writing = false
            drainWrites(g)
        }
    }

    @ReactMethod
    fun connect(deviceId: String, promise: Promise) {
        if (!hasPermission()) {
            promise.reject("E_PERMISSION", "BLUETOOTH_CONNECT not granted")
            return
        }
        try {
            gatt?.close()
        } catch (_: Exception) {
        }
        gatt = null
        val device: BluetoothDevice? = try {
            adapter()?.getRemoteDevice(deviceId)
        } catch (e: IllegalArgumentException) {
            null
        }
        if (device == null) {
            promise.reject("E_DEVICE", "unknown device: $deviceId")
            return
        }
        connectPromise = promise
        val g = device.connectGatt(reactApplicationContext, false, gattCallback)
        if (g == null) {
            connectPromise = null
            promise.reject("E_CONNECT", "connectGatt returned null")
            return
        }
        gatt = g
    }

    // ---- write (chunked) ------------------------------------------------------

    @ReactMethod
    fun write(b64: String, promise: Promise) {
        val g = gatt
        val rx = rxChar
        if (g == null || rx == null) {
            promise.reject("E_NOT_CONNECTED", "not connected")
            return
        }
        val data = Base64.decode(b64, Base64.NO_WRAP)
        var i = 0
        while (i < data.size) {
            val end = minOf(i + CHUNK, data.size)
            writeQueue.add(data.copyOfRange(i, end))
            i = end
        }
        drainWrites(g)
        promise.resolve(true)
    }

    private fun drainWrites(g: BluetoothGatt) {
        if (writing) return
        val chunk = writeQueue.poll() ?: return
        val rx = rxChar ?: return
        writing = true
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            g.writeCharacteristic(rx, chunk, BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT)
        } else {
            @Suppress("DEPRECATION")
            rx.setValue(chunk)
            @Suppress("DEPRECATION")
            rx.writeType = BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
            @Suppress("DEPRECATION")
            g.writeCharacteristic(rx)
        }
    }

    @ReactMethod
    fun disconnect() {
        try {
            gatt?.disconnect()
        } catch (_: Exception) {
        }
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
        stopScanInternal()
        try {
            gatt?.disconnect()
        } catch (_: Exception) {
        }
    }
}
