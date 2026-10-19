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
        val CCC_DESCRIPTOR: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")
        // Contrato de descoberta appa (advertido pelo firmware; ver PROTOCOL.md).
        val APPA_SERVICE: UUID = UUID.fromString("61707061-0000-1000-8000-00805f9b34fb")
        const val CHUNK = 180 // conservative until MTU is known
    }

    private var adapterCache: BluetoothAdapter? = null

    private fun adapter(): BluetoothAdapter? {
        if (adapterCache == null) {
            val manager = reactApplicationContext.applicationContext
                .getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
            adapterCache = manager?.adapter
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

    private fun hasPermission(): Boolean {
        val ctx = reactApplicationContext.applicationContext
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            ctx.checkSelfPermission(Manifest.permission.BLUETOOTH_SCAN) == PackageManager.PERMISSION_GRANTED &&
                ctx.checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED
        } else true
    }

    private fun emit(event: String, params: com.facebook.react.bridge.WritableMap?) {
        reactApplicationContext.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit(event, params)
    }

    // ---- scan ---------------------------------------------------------------

    private val scanCallback = object : ScanCallback() {
        override fun onScanResult(callbackType: Int, result: ScanResult) {
            val device: BluetoothDevice = result.device
            val rec = result.scanRecord
            // Sem ScanFilter no startScan (o filtro nativo por UUID 128-bit nao
            // casa em varios Androids): filtramos aqui pelo servico appa, que o
            // firmware anuncia no pacote principal (Complete List of 128-bit).
            val hasAppa = rec?.serviceUuids?.contains(android.os.ParcelUuid(APPA_SERVICE)) == true ||
                rec?.getServiceData(android.os.ParcelUuid(APPA_SERVICE)) != null
            android.util.Log.d("AppaBle", "result ${device.address} name=${device.name} uuids=${rec?.serviceUuids} appa=$hasAppa")
            if (!hasAppa) return
            val name = device.name ?: rec?.deviceName ?: "Familiar"
            val state = readSetupState(result)
            val entry = mapOf("id" to device.address, "name" to name, "rssi" to result.rssi, "state" to state)
            val prev = found[device.address]
            if (prev != null && prev["name"] == name && prev["state"] == state) return
            found[device.address] = entry
            val params = Arguments.createMap().apply {
                putString("id", device.address)
                putString("name", name)
                putInt("rssi", result.rssi)
                putInt("state", state)
            }
            emit("AppaBleDevice", params)
        }

        override fun onScanFailed(errorCode: Int) {
            scanning = false
            scanPromise?.reject("E_SCAN", "scan failed: $errorCode")
            scanPromise = null
        }
    }

    /** Último byte de estado em Service Data do UUID appa (-1 quando ausente). */
    private fun readSetupState(result: ScanResult): Int {
        return try {
            val data = result.scanRecord?.getServiceData(android.os.ParcelUuid(APPA_SERVICE))
            if (data != null && data.isNotEmpty()) data[0].toInt() and 0xFF else -1
        } catch (_: Throwable) {
            -1
        }
    }

    @ReactMethod
    fun scan(timeoutMs: Int, promise: Promise) {
        try {
            if (!hasPermission()) {
                promise.reject("E_PERMISSION", "BLUETOOTH_SCAN/BLUETOOTH_CONNECT not granted")
                return
            }
            stopScanInternal()
            found.clear()
            scanPromise = promise
            val scanner = try {
                adapter()?.bluetoothLeScanner
            } catch (e: Throwable) {
                scanPromise = null
                promise.reject("E_ADAPTER", "bluetoothLeScanner: " + (e.message ?: e.toString()))
                return
            }
            if (scanner == null) {
                scanPromise = null
                promise.reject("E_NO_ADAPTER", "no BLE adapter/scanner")
                return
            }
            scanning = true
            try {
                val scanSettings = android.bluetooth.le.ScanSettings.Builder()
                    .setScanMode(android.bluetooth.le.ScanSettings.SCAN_MODE_LOW_LATENCY)
                    .build()
                // sem filtro nativo: filtramos pelo servico appa no callback
                // (ScanFilter por UUID 128-bit nao casa em varios Androids)
                scanner.startScan(null, scanSettings, scanCallback)
            } catch (e: Throwable) {
                scanning = false
                scanPromise = null
                val frames = e.stackTrace.take(4).joinToString(" <- ") { it.className + "." + it.methodName + ":" + it.lineNumber }
                promise.reject("E_STARTSCAN", "startScan: " + e.javaClass.name + " / " + (e.message ?: "") + " @ " + frames)
                return
            }
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
                        putInt("state", (entry["state"] as Int))
                    })
                }
                promise.resolve(list)
            }.start()
        } catch (e: Throwable) {
            scanPromise = null
            scanning = false
            promise.reject("E_SCAN", e.message ?: e.toString(), e)
        }
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
            if (newState == BluetoothProfile.STATE_CONNECTED) {
                // connectGatt nao descobre servicos sozinho: sem isto o NUS
                // nunca e encontrado e o notify (CCCD) nunca e assinado.
                try {
                    g.discoverServices()
                } catch (e: Throwable) {
                    connectPromise?.reject("E_SERVICES", "discoverServices: " + (e.message ?: e.toString()))
                    connectPromise = null
                }
                return
            }
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
            enableTxNotify(g)
        }

        override fun onMtuChanged(g: BluetoothGatt, mtu: Int, status: Int) {
            enableTxNotify(g)
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

    private fun enableTxNotify(g: BluetoothGatt) {
        val tx = txChar ?: return
        g.setCharacteristicNotification(tx, true)
        val descriptor = tx.getDescriptor(CCC_DESCRIPTOR)
        if (descriptor != null) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                g.writeDescriptor(descriptor, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE)
            } else {
                @Suppress("DEPRECATION")
                descriptor.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
                @Suppress("DEPRECATION")
                g.writeDescriptor(descriptor)
            }
        } else {
            // sem CCCD: resolve o connect direto na 1a notificacao habilitada
            connectPromise?.resolve(null)
            connectPromise = null
        }
    }

    @ReactMethod
    fun connect(deviceId: String, promise: Promise) {
        try {
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
        } catch (e: Throwable) {
            connectPromise = null
            promise.reject("E_CONNECT", e.message ?: e.toString(), e)
        }
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
