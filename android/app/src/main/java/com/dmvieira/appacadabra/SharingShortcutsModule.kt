package ai.appacadabra.app

import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import androidx.core.content.pm.ShortcutInfoCompat
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.core.graphics.drawable.IconCompat
import com.facebook.react.bridge.*
import java.io.File
import java.net.URL

class SharingShortcutsModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "SharingShortcuts"

    @ReactMethod
    fun publishShortcut(id: String, name: String, iconUri: String?, promise: Promise) {
        try {
            val context = reactApplicationContext
            
            // Create intent that will be fired when shortcut is selected
            val intent = Intent(context, MainActivity::class.java).apply {
                action = Intent.ACTION_SEND
                putExtra("shortcut_id", id)
                addCategory("ai.appacadabra.app.category.SHARE_TARGET")
            }
            
            // Build shortcut
            val shortcutBuilder = ShortcutInfoCompat.Builder(context, "webapp_" + id)
                .setShortLabel(name)
                .setLongLabel(name)
                .setIntent(intent)
                .setCategories(setOf("ai.appacadabra.app.category.SHARE_TARGET"))
                .setLongLived(true)
            
            // Add icon if available
            if (!iconUri.isNullOrEmpty()) {
                try {
                    val iconFile = File(Uri.parse(iconUri).path ?: "")
                    if (iconFile.exists()) {
                        val bitmap = BitmapFactory.decodeFile(iconFile.absolutePath)
                        if (bitmap != null) {
                            shortcutBuilder.setIcon(IconCompat.createWithBitmap(bitmap))
                        }
                    }
                } catch (e: Exception) {
                    // Use default icon on error
                }
            }
            
            // Publish the shortcut
            val shortcut = shortcutBuilder.build()
            ShortcutManagerCompat.pushDynamicShortcut(context, shortcut)
            
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("ERROR", e.message)
        }
    }

    @ReactMethod
    fun removeShortcut(id: String, promise: Promise) {
        try {
            ShortcutManagerCompat.removeDynamicShortcuts(
                reactApplicationContext,
                listOf("webapp_" + id)
            )
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("ERROR", e.message)
        }
    }

    @ReactMethod
    fun removeAllShortcuts(promise: Promise) {
        try {
            ShortcutManagerCompat.removeAllDynamicShortcuts(reactApplicationContext)
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("ERROR", e.message)
        }
    }
    
    @ReactMethod
    fun getMaxShortcutCount(promise: Promise) {
        try {
            val maxCount = ShortcutManagerCompat.getMaxShortcutCountPerActivity(reactApplicationContext)
            promise.resolve(maxCount)
        } catch (e: Exception) {
            promise.reject("ERROR", e.message)
        }
    }
}
