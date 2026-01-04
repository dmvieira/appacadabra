package com.example.appacadabra.utils

import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import androidx.core.content.pm.ShortcutInfoCompat
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.core.graphics.drawable.IconCompat
import com.example.appacadabra.AppRunnerActivity
import com.example.appacadabra.R
import com.example.appacadabra.data.GeneratedApp
import java.io.File

object ShortcutHelper {

    fun createShortcut(context: Context, app: GeneratedApp, shortcutName: String) {
        if (ShortcutManagerCompat.isRequestPinShortcutSupported(context)) {
            val intent = Intent(context, AppRunnerActivity::class.java).apply {
                action = Intent.ACTION_VIEW
                putExtra("APP_ID", app.id)
                // Make it appear as a separate app in recent apps
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
            }

            // Try to use custom icon, fallback to default
            val icon = getAppIcon(context, app.iconPath)
            
            val shortcutInfo = ShortcutInfoCompat.Builder(context, "app_${app.id}")
                .setShortLabel(shortcutName)
                .setLongLabel(shortcutName)
                .setIcon(icon)
                .setIntent(intent)
                .build()

            ShortcutManagerCompat.requestPinShortcut(context, shortcutInfo, null)
        }
    }
    
    /**
     * Updates the dynamic shortcuts shown when long-pressing the app icon.
     * Shows up to 10 most recent apps.
     */
    fun updateDynamicShortcuts(context: Context, apps: List<GeneratedApp>) {
        // Get max shortcuts allowed (usually 10)
        val maxShortcuts = ShortcutManagerCompat.getMaxShortcutCountPerActivity(context)
            .coerceAtMost(10)
        
        // Take the most recent apps
        val recentApps = apps.sortedByDescending { it.lastUpdated }.take(maxShortcuts)
        
        val shortcuts = recentApps.map { app ->
            val intent = Intent(context, AppRunnerActivity::class.java).apply {
                action = Intent.ACTION_VIEW
                putExtra("APP_ID", app.id)
                putExtra("APP_CODE", app.code)
                addFlags(Intent.FLAG_ACTIVITY_NEW_DOCUMENT)
            }
            
            val icon = getAppIcon(context, app.iconPath)
            
            ShortcutInfoCompat.Builder(context, "dynamic_app_${app.id}")
                .setShortLabel(app.name.take(25))
                .setLongLabel(app.name)
                .setIcon(icon)
                .setIntent(intent)
                .setRank(recentApps.indexOf(app))
                .build()
        }
        
        ShortcutManagerCompat.setDynamicShortcuts(context, shortcuts)
    }
    
    /**
     * Removes a dynamic shortcut when an app is deleted.
     */
    fun removeDynamicShortcut(context: Context, appId: Long) {
        ShortcutManagerCompat.removeDynamicShortcuts(context, listOf("dynamic_app_$appId"))
    }
    
    private fun getAppIcon(context: Context, iconPath: String?): IconCompat {
        if (iconPath != null) {
            val file = File(iconPath)
            if (file.exists()) {
                try {
                    val bitmap = BitmapFactory.decodeFile(iconPath)
                    if (bitmap != null) {
                        // Resize to appropriate icon size
                        val scaledBitmap = Bitmap.createScaledBitmap(bitmap, 192, 192, true)
                        return IconCompat.createWithBitmap(scaledBitmap)
                    }
                } catch (e: Exception) {
                    e.printStackTrace()
                }
            }
        }
        // Fallback to default icon
        return IconCompat.createWithResource(context, R.mipmap.ic_launcher)
    }
}
