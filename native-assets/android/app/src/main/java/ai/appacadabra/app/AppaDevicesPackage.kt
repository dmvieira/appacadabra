package ai.appacadabra.app

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

/**
 * Registers the appa device transports: AppaTcpModule (dev/QA vs appa-sim)
 * and AppaBleModule (production, NUS). The iOS twin mirrors the same JS
 * contract over CoreBluetooth.
 */
class AppaDevicesPackage : ReactPackage {
    override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> =
        listOf(AppaTcpModule(reactContext), AppaBleModule(reactContext))

    override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> = emptyList()
}
