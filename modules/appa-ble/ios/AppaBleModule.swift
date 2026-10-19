import CoreBluetooth
import ExpoModulesCore

private let kNusService = CBUUID(string: "6e400001-b5a3-f393-e0a9-e50e24dcca9e")
private let kNusRx = CBUUID(string: "6e400002-b5a3-f393-e0a9-e50e24dcca9e")
private let kNusTx = CBUUID(string: "6e400003-b5a3-f393-e0a9-e50e24dcca9e")
// Discovery contract (see PROTOCOL.md §3.1.2): scan is filtered by this UUID and
// the 1-byte setup state comes from Service Data of the same UUID.
private let kAppaService = CBUUID(string: "61707061-0000-1000-8000-00805f9b34fb")

/// CoreBluetooth central for BLE NUS — the iOS twin of the Android AppaBleModule.
/// Emits the same events so `lib/devices/bleTransport.ts` is unchanged.
final class AppaBleCentral: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate {
  private var central: CBCentralManager!
  private let queue = DispatchQueue(label: "ai.appacadabra.ble")
  private var peripherals: [String: CBPeripheral] = [:]
  private var found: [String: [String: Any]] = [:]
  private var scanPromise: Promise?
  private var scanTimer: DispatchWorkItem?
  private var connectPromise: Promise?
  private var rxChar: CBCharacteristic?
  private var txChar: CBCharacteristic?
  private var connectedId: String?

  var onDevice: (([String: Any]) -> Void)?
  var onConnected: (() -> Void)?
  var onData: ((String) -> Void)?
  var onDisconnect: (() -> Void)?

  override init() {
    super.init()
    central = CBCentralManager(delegate: self, queue: queue)
  }

  func scan(timeoutMs: Int, promise: Promise) {
    guard central.state == .poweredOn else {
      promise.reject("E_ADAPTER", "bluetooth not powered on")
      return
    }
    found.removeAll()
    scanPromise = promise
    central.scanForPeripherals(withServices: [kAppaService], options: [
      CBCentralManagerScanOptionAllowDuplicatesKey: false,
    ])
    let work = DispatchWorkItem { [weak self] in self?.finishScan() }
    scanTimer = work
    queue.asyncAfter(deadline: .now() + Double(timeoutMs) / 1000.0, execute: work)
  }

  func stopScan() {
    if central.state == .poweredOn { central.stopScan() }
  }

  private func finishScan() {
    if central.state == .poweredOn { central.stopScan() }
    scanTimer?.cancel()
    scanTimer = nil
    scanPromise?.resolve(Array(found.values))
    scanPromise = nil
  }

  func connect(deviceId: String, promise: Promise) {
    guard let peripheral = peripherals[deviceId] else {
      promise.reject("E_DEVICE", "unknown device: \(deviceId)")
      return
    }
    connectPromise = promise
    queue.async { self.central.connect(peripheral, options: nil) }
  }

  func disconnect() {
    if let id = connectedId, let p = peripherals[id] {
      central.cancelPeripheralConnection(p)
    }
  }

  func write(b64: String, promise: Promise) {
    guard let id = connectedId, let peripheral = peripherals[id], let rx = rxChar,
          let data = Data(base64Encoded: b64) else {
      promise.reject("E_NOT_CONNECTED", "not connected")
      return
    }
    let chunk = 180 // conservative until MTU is known
    var i = 0
    while i < data.count {
      let end = min(i + chunk, data.count)
      peripheral.writeValue(data.subdata(in: i..<end), for: rx, type: .withoutResponse)
      i = end
    }
    promise.resolve(true)
  }

  private func readSetupState(_ advertisementData: [String: Any]) -> Int {
    guard let sd = advertisementData[CBAdvertisementDataServiceDataKey] as? [CBUUID: Data],
          let data = sd[kAppaService], let first = data.first else {
      return -1
    }
    return Int(first)
  }

  // MARK: CBCentralManagerDelegate

  func centralManagerDidUpdateState(_ central: CBCentralManager) {}

  func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral,
                      advertisementData: [String: Any], rssi RSSI: NSNumber) {
    let id = peripheral.identifier.uuidString
    let name = (advertisementData[CBAdvertisementDataLocalNameKey] as? String) ?? peripheral.name ?? "appa"
    let state = readSetupState(advertisementData)
    peripherals[id] = peripheral
    if let prev = found[id], (prev["name"] as? String) == name, (prev["state"] as? Int) == state { return }
    let entry: [String: Any] = ["id": id, "name": name, "rssi": RSSI.intValue, "state": state]
    found[id] = entry
    onDevice?(entry)
  }

  func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
    connectedId = peripheral.identifier.uuidString
    peripheral.delegate = self
    peripheral.discoverServices([kNusService])
  }

  func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
    connectPromise?.reject("E_CONNECT", error?.localizedDescription ?? "connect failed")
    connectPromise = nil
  }

  func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
    connectedId = nil
    rxChar = nil
    txChar = nil
    onDisconnect?()
    connectPromise?.reject("E_DISCONNECTED", error?.localizedDescription ?? "disconnected")
    connectPromise = nil
  }

  // MARK: CBPeripheralDelegate

  func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
    guard error == nil, let services = peripheral.services,
          let nus = services.first(where: { $0.uuid == kNusService }) else {
      connectPromise?.reject("E_NO_NUS", error?.localizedDescription ?? "device does not expose NUS")
      connectPromise = nil
      central.cancelPeripheralConnection(peripheral)
      return
    }
    peripheral.discoverCharacteristics([kNusRx, kNusTx], for: nus)
  }

  func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
    guard error == nil, let chars = service.characteristics else {
      connectPromise?.reject("E_NO_NUS", error?.localizedDescription ?? "characteristics missing")
      connectPromise = nil
      return
    }
    rxChar = chars.first(where: { $0.uuid == kNusRx })
    txChar = chars.first(where: { $0.uuid == kNusTx })
    guard let tx = txChar else {
      connectPromise?.reject("E_NO_NUS", "NUS characteristics missing")
      connectPromise = nil
      return
    }
    peripheral.setNotifyValue(true, for: tx)
  }

  func peripheral(_ peripheral: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic, error: Error?) {
    if characteristic.uuid == kNusTx, error == nil {
      connectPromise?.resolve(true)
      connectPromise = nil
      onConnected?()
    }
  }

  func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
    guard characteristic.uuid == kNusTx, let value = characteristic.value else { return }
    onData?(value.base64EncodedString())
  }
}

public class AppaBleModule: Module {
  private let central = AppaBleCentral()

  public func definition() -> ModuleDefinition {
    Name("AppaBleModule")
    Events("AppaBleDevice", "AppaBleConnected", "AppaBleData", "AppaBleDisconnect")

    OnCreate {
      central.onDevice = { [weak self] entry in self?.sendEvent("AppaBleDevice", entry) }
      central.onConnected = { [weak self] in self?.sendEvent("AppaBleConnected", [:]) }
      central.onData = { [weak self] b64 in self?.sendEvent("AppaBleData", ["base64": b64]) }
      central.onDisconnect = { [weak self] in self?.sendEvent("AppaBleDisconnect", [:]) }
    }

    AsyncFunction("scan") { (timeoutMs: Int, promise: Promise) in
      central.scan(timeoutMs: timeoutMs, promise: promise)
    }

    Function("stopScan") {
      central.stopScan()
    }

    AsyncFunction("connect") { (deviceId: String, promise: Promise) in
      central.connect(deviceId: deviceId, promise: promise)
    }

    AsyncFunction("write") { (b64: String, promise: Promise) in
      central.write(b64: b64, promise: promise)
    }

    Function("disconnect") {
      central.disconnect()
    }

    OnDestroy {
      central.stopScan()
      central.disconnect()
    }
  }
}
