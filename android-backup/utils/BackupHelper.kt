package com.example.appacadabra.utils

import android.content.Context
import android.net.Uri
import android.util.Base64
import com.example.appacadabra.data.AppStorage
import com.example.appacadabra.data.AppVersion
import com.example.appacadabra.data.GeneratedApp
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

object BackupHelper {
    
    data class BackupData(
        val apps: List<GeneratedApp>,
        val icons: Map<Long, ByteArray> // appId -> icon bytes
    )
    
    data class ParsedBackup(
        val apps: List<GeneratedApp>,
        val versions: Map<Long, List<AppVersion>>, // original appId -> versions
        val storage: Map<Long, Map<String, String>> // original appId -> (key -> value)
    )
    
    fun createBackup(
        context: Context, 
        apps: List<GeneratedApp>,
        appVersions: Map<Long, List<AppVersion>>,
        appStorage: Map<Long, List<AppStorage>>
    ): String {
        val jsonObject = JSONObject()
        
        // Backup version
        jsonObject.put("version", 2) // Incremented version for new format
        jsonObject.put("createdAt", System.currentTimeMillis())
        
        // Apps array
        val appsArray = JSONArray()
        apps.forEach { app ->
            val appJson = JSONObject().apply {
                put("id", app.id)
                put("name", app.name)
                put("code", app.code)
                put("currentVersion", app.currentVersion)
                put("lastUpdated", app.lastUpdated)
                
                // Encode icon as base64 if exists
                app.iconPath?.let { path ->
                    val iconFile = File(path)
                    if (iconFile.exists()) {
                        val bytes = iconFile.readBytes()
                        put("iconBase64", Base64.encodeToString(bytes, Base64.NO_WRAP))
                    }
                }
                
                // Add version history
                val versionsArray = JSONArray()
                appVersions[app.id]?.forEach { version ->
                    val versionJson = JSONObject().apply {
                        put("version", version.version)
                        put("code", version.code)
                        put("instruction", version.instruction ?: "")
                        put("selectedContext", version.selectedContext ?: "")
                        put("createdAt", version.createdAt)
                    }
                    versionsArray.put(versionJson)
                }
                put("versions", versionsArray)
                
                // Add localStorage data
                val storageJson = JSONObject()
                appStorage[app.id]?.forEach { item ->
                    storageJson.put(item.key, item.value)
                }
                put("localStorage", storageJson)
            }
            appsArray.put(appJson)
        }
        jsonObject.put("apps", appsArray)
        
        return jsonObject.toString(2)
    }
    
    fun writeBackupToUri(context: Context, uri: Uri, backupJson: String): Boolean {
        return try {
            context.contentResolver.openOutputStream(uri)?.use { outputStream ->
                outputStream.write(backupJson.toByteArray(Charsets.UTF_8))
            }
            true
        } catch (e: Exception) {
            e.printStackTrace()
            false
        }
    }
    
    fun readBackupFromUri(context: Context, uri: Uri): String? {
        return try {
            context.contentResolver.openInputStream(uri)?.use { inputStream ->
                inputStream.bufferedReader().readText()
            }
        } catch (e: Exception) {
            e.printStackTrace()
            null
        }
    }
    
    fun parseBackup(context: Context, backupJson: String): ParsedBackup? {
        return try {
            val jsonObject = JSONObject(backupJson)
            val appsArray = jsonObject.getJSONArray("apps")
            
            val apps = mutableListOf<GeneratedApp>()
            val versionsMap = mutableMapOf<Long, List<AppVersion>>()
            val storageMap = mutableMapOf<Long, Map<String, String>>()
            val iconDir = File(context.filesDir, "icons")
            if (!iconDir.exists()) iconDir.mkdirs()
            
            for (i in 0 until appsArray.length()) {
                val appJson = appsArray.getJSONObject(i)
                val originalId = appJson.optLong("id", i.toLong())
                
                var iconPath: String? = null
                
                // Restore icon if present
                if (appJson.has("iconBase64")) {
                    val iconBase64 = appJson.getString("iconBase64")
                    val iconBytes = Base64.decode(iconBase64, Base64.NO_WRAP)
                    val iconFile = File(iconDir, "app_restored_${System.currentTimeMillis()}_$i.png")
                    iconFile.writeBytes(iconBytes)
                    iconPath = iconFile.absolutePath
                }
                
                val app = GeneratedApp(
                    id = 0, // Will be auto-generated on insert
                    name = appJson.getString("name"),
                    code = appJson.getString("code"),
                    currentVersion = appJson.optInt("currentVersion", 1),
                    iconPath = iconPath,
                    lastUpdated = appJson.optLong("lastUpdated", System.currentTimeMillis())
                )
                apps.add(app)
                
                // Parse versions if present
                if (appJson.has("versions")) {
                    val versionsArray = appJson.getJSONArray("versions")
                    val versions = mutableListOf<AppVersion>()
                    for (j in 0 until versionsArray.length()) {
                        val versionJson = versionsArray.getJSONObject(j)
                        versions.add(
                            AppVersion(
                                id = 0,
                                appId = 0, // Will be set after app is inserted
                                version = versionJson.optInt("version", 1),
                                code = versionJson.optString("code", ""),
                                instruction = versionJson.optString("instruction").takeIf { it.isNotEmpty() },
                                selectedContext = versionJson.optString("selectedContext").takeIf { it.isNotEmpty() },
                                createdAt = versionJson.optLong("createdAt", System.currentTimeMillis())
                            )
                        )
                    }
                    versionsMap[originalId] = versions
                }
                
                // Parse localStorage if present
                if (appJson.has("localStorage")) {
                    val storageJson = appJson.getJSONObject("localStorage")
                    val storageData = mutableMapOf<String, String>()
                    storageJson.keys().forEach { key ->
                        storageData[key] = storageJson.optString(key, "")
                    }
                    if (storageData.isNotEmpty()) {
                        storageMap[originalId] = storageData
                    }
                }
            }
            
            ParsedBackup(apps, versionsMap, storageMap)
        } catch (e: Exception) {
            e.printStackTrace()
            null
        }
    }
    
    // Legacy parse for old format without versions
    fun parseBackupLegacy(context: Context, backupJson: String): List<GeneratedApp>? {
        return parseBackup(context, backupJson)?.apps
    }
}
