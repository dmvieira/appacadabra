package expo.modules.shortcuts

import android.content.Context
import android.content.Intent
import android.graphics.BitmapFactory
import android.net.Uri
import androidx.core.content.pm.ShortcutInfoCompat
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.core.graphics.drawable.IconCompat
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File

class ShortcutsModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("Shortcuts")

    AsyncFunction("createShortcut") { id: String, name: String, iconPath: String? ->
      val context = appContext.reactContext ?: return@AsyncFunction false

      if (ShortcutManagerCompat.isRequestPinShortcutSupported(context)) {
        val launchUri = Uri.parse("runapp://runner/$id")
        val intent = Intent(Intent.ACTION_VIEW, launchUri)
        intent.setPackage(context.packageName)
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NEW_DOCUMENT)

        val builder = ShortcutInfoCompat.Builder(context, "app_$id")
          .setShortLabel(name)
          .setLongLabel(name)
          .setIntent(intent)

        if (iconPath != null) {
          try {
            val cleanPath = if (iconPath.startsWith("file://")) iconPath.substring(7) else iconPath
            val file = File(cleanPath)
            if (file.exists()) {
              val bitmap = BitmapFactory.decodeFile(cleanPath)
              if (bitmap != null) {
                builder.setIcon(IconCompat.createWithBitmap(bitmap))
              }
            }
          } catch (e: Exception) {
            e.printStackTrace()
          }
        }

        val shortcutInfo = builder.build()
        ShortcutManagerCompat.requestPinShortcut(context, shortcutInfo, null)
        return@AsyncFunction true
      }
      return@AsyncFunction false
    }

    AsyncFunction("setDynamicShortcuts") { items: List<Map<String, Any?>> ->
        val context = appContext.reactContext ?: return@AsyncFunction
        
        val shortcuts = items.mapIndexed { index, item ->
            val id = item["id"] as String
            val name = item["name"] as String
            val iconPath = item["iconPath"] as? String
            
            val launchUri = Uri.parse("runapp://runner/$id")
            val intent = Intent(Intent.ACTION_VIEW, launchUri)
            intent.setPackage(context.packageName)
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NEW_DOCUMENT)

            val builder = ShortcutInfoCompat.Builder(context, "dynamic_$id")
                .setShortLabel(name)
                .setLongLabel(name)
                .setIntent(intent)
                .setRank(index)

            if (iconPath != null) {
                try {
                    val cleanPath = if (iconPath.startsWith("file://")) iconPath.substring(7) else iconPath
                    val file = File(cleanPath)
                    if (file.exists()) {
                        val bitmap = BitmapFactory.decodeFile(cleanPath)
                        if (bitmap != null) {
                            builder.setIcon(IconCompat.createWithBitmap(bitmap))
                        }
                    }
                } catch (e: Exception) {
                   e.printStackTrace()
                }
            }
            
            builder.build()
        }

        ShortcutManagerCompat.setDynamicShortcuts(context, shortcuts)
    }
  }
}
