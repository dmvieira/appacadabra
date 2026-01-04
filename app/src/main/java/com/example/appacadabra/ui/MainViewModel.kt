package com.example.appacadabra.ui

import android.app.Application
import android.net.Uri
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import androidx.room.Room
import com.example.appacadabra.api.GeminiClient
import com.example.appacadabra.data.AppDatabase
import com.example.appacadabra.data.AppVersion
import com.example.appacadabra.data.GeneratedApp
import com.example.appacadabra.utils.BackupHelper
import com.example.appacadabra.utils.CodeExtractor
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import java.io.File

sealed class AppsUiState {
    object Loading : AppsUiState()
    data class Success(val apps: List<GeneratedApp>) : AppsUiState()
}

class MainViewModel(application: Application) : AndroidViewModel(application) {

    private val context = application.applicationContext
    
    private val db = Room.databaseBuilder(
        application,
        AppDatabase::class.java, "appacadabra-db"
    )
        .addMigrations(AppDatabase.MIGRATION_1_2, AppDatabase.MIGRATION_2_3, AppDatabase.MIGRATION_3_4, AppDatabase.MIGRATION_4_5, AppDatabase.MIGRATION_5_6)
        .build()

    private val dao = db.appDao()
    
    val appsState: StateFlow<AppsUiState> = dao.getAllApps()
        .map { AppsUiState.Success(it) }
        .stateIn(
            scope = viewModelScope,
            started = SharingStarted.WhileSubscribed(5000),
            initialValue = AppsUiState.Loading
        )

    private val geminiClient = GeminiClient()

    private val _isGenerating = MutableStateFlow(false)
    val isGenerating = _isGenerating.asStateFlow()
    
    private val _chatError = MutableStateFlow<String?>(null)
    val chatError = _chatError.asStateFlow()
    
    private val _backupStatus = MutableStateFlow<String?>(null)
    val backupStatus = _backupStatus.asStateFlow()

    fun createApp(description: String, onComplete: () -> Unit) {
        viewModelScope.launch {
            _isGenerating.value = true
            _chatError.value = null
            val result = geminiClient.generateApp(description)
            
            result.onSuccess { response ->
                val code = CodeExtractor.extractHtml(response)
                val newApp = GeneratedApp(
                    name = description.take(20) + "...",
                    code = code,
                    currentVersion = 1
                )
                val appId = dao.insertApp(newApp)
                
                // Save initial version
                dao.insertVersion(AppVersion(
                    appId = appId,
                    version = 1,
                    code = code
                ))
                
                onComplete()
            }.onFailure { e ->
                _chatError.value = "Failed to generate app: ${e.message}"
            }
            _isGenerating.value = false
        }
    }

    fun deleteApp(app: GeneratedApp) {
        viewModelScope.launch {
            // Delete icon file
            app.iconPath?.let { path ->
                try {
                    File(path).delete()
                } catch (e: Exception) {
                    e.printStackTrace()
                }
            }
            dao.deleteApp(app)
        }
    }
    
    fun updateApp(app: GeneratedApp, instructions: String, onComplete: () -> Unit) {
        viewModelScope.launch {
            _isGenerating.value = true
            _chatError.value = null
            val result = geminiClient.editApp(app.code, instructions)
            
            result.onSuccess { response ->
                val code = CodeExtractor.extractHtml(response)
                val newVersion = app.currentVersion + 1
                val updatedApp = app.copy(
                    code = code, 
                    currentVersion = newVersion,
                    lastUpdated = System.currentTimeMillis()
                )
                dao.updateApp(updatedApp)
                
                // Save new version to history
                dao.insertVersion(AppVersion(
                    appId = app.id,
                    version = newVersion,
                    code = code
                ))
                
                onComplete()
            }.onFailure { e ->
                 _chatError.value = "Failed to update app: ${e.message}"
            }
            _isGenerating.value = false
        }
    }
    
    fun renameApp(app: GeneratedApp, newName: String) {
        viewModelScope.launch {
            val renamedApp = app.copy(name = newName)
            dao.updateApp(renamedApp)
        }
    }
    
    fun updateAppIcon(app: GeneratedApp, iconPath: String) {
        viewModelScope.launch {
            val updatedApp = app.copy(iconPath = iconPath, lastUpdated = System.currentTimeMillis())
            dao.updateApp(updatedApp)
        }
    }
    
    suspend fun getVersionsForApp(appId: Long): List<AppVersion> {
        return dao.getVersionsForApp(appId)
    }
    
    fun switchToVersion(app: GeneratedApp, version: AppVersion) {
        viewModelScope.launch {
            val updatedApp = app.copy(
                code = version.code,
                currentVersion = version.version,
                lastUpdated = System.currentTimeMillis()
            )
            dao.updateApp(updatedApp)
        }
    }
    
    // Backup functions
    fun exportBackup(uri: Uri) {
        viewModelScope.launch {
            try {
                _backupStatus.value = "Criando backup..."
                val allApps = dao.getAllApps().first()
                
                android.util.Log.d("BackupExport", "Exporting ${allApps.size} apps")
                
                // Fetch versions for all apps
                val appVersions = mutableMapOf<Long, List<AppVersion>>()
                allApps.forEach { app ->
                    val versions = dao.getVersionsForApp(app.id)
                    appVersions[app.id] = versions
                    android.util.Log.d("BackupExport", "App ${app.id} '${app.name}': ${versions.size} versions")
                }
                
                // Also fetch storage for each app
                val appStorage = mutableMapOf<Long, List<com.example.appacadabra.data.AppStorage>>()
                allApps.forEach { app ->
                    val storage = dao.getStorageForApp(app.id)
                    appStorage[app.id] = storage
                    android.util.Log.d("BackupExport", "App ${app.id} '${app.name}': ${storage.size} storage items")
                }
                
                val backupJson = BackupHelper.createBackup(context, allApps, appVersions, appStorage)
                android.util.Log.d("BackupExport", "Backup JSON length: ${backupJson.length}")
                
                val success = BackupHelper.writeBackupToUri(context, uri, backupJson)
                if (success) {
                    val totalVersions = appVersions.values.sumOf { it.size }
                    val totalStorage = appStorage.values.sumOf { it.size }
                    _backupStatus.value = "Backup salvo! (${allApps.size} apps, $totalVersions versões, $totalStorage itens storage)"
                } else {
                    _backupStatus.value = "Erro ao salvar backup"
                }
            } catch (e: Exception) {
                e.printStackTrace()
                _backupStatus.value = "Erro: ${e.message}"
            }
        }
    }
    
    fun importBackup(uri: Uri) {
        viewModelScope.launch {
            try {
                _backupStatus.value = "Restaurando backup..."
                val backupJson = BackupHelper.readBackupFromUri(context, uri)
                if (backupJson != null) {
                    val parsedBackup = BackupHelper.parseBackup(context, backupJson)
                    
                    if (parsedBackup != null && parsedBackup.apps.isNotEmpty()) {
                        parsedBackup.apps.forEachIndexed { index, app ->
                            val originalId = app.id // Store temporary ID before insert
                            val appId = dao.insertApp(app) // Insert gets new ID
                            
                            // Restore versions if available
                            val versions = parsedBackup.versions[originalId]
                            if (versions != null && versions.isNotEmpty()) {
                                versions.forEach { version ->
                                    dao.insertVersion(version.copy(id = 0, appId = appId))
                                }
                            } else {
                                // Fallback: Save initial version if none in backup
                                dao.insertVersion(AppVersion(
                                    appId = appId,
                                    version = app.currentVersion,
                                    code = app.code
                                ))
                            }
                            
                            // Restore localStorage if available
                            val storage = parsedBackup.storage[originalId]
                            if (!storage.isNullOrEmpty()) {
                                storage.forEach { (key, value) ->
                                    dao.setStorageItem(com.example.appacadabra.data.AppStorage(
                                        appId = appId,
                                        key = key,
                                        value = value
                                    ))
                                }
                            }
                        }
                        _backupStatus.value = "${parsedBackup.apps.size} apps restaurados com dados!"
                    } else {
                         // Try legacy format
                        val legacyApps = BackupHelper.parseBackupLegacy(context, backupJson)
                        if (legacyApps != null && legacyApps.isNotEmpty()) {
                             legacyApps.forEach { app ->
                                val appId = dao.insertApp(app)
                                dao.insertVersion(AppVersion(
                                    appId = appId,
                                    version = app.currentVersion,
                                    code = app.code
                                ))
                            }
                            _backupStatus.value = "${legacyApps.size} apps restaurados (legado)!"
                        } else {
                            _backupStatus.value = "Nenhum app encontrado no backup"
                        }
                    }
                } else {
                    _backupStatus.value = "Erro ao ler arquivo de backup"
                }
            } catch (e: Exception) {
                e.printStackTrace()
                _backupStatus.value = "Erro: ${e.message}"
            }
        }
    }
    
    fun clearBackupStatus() {
        _backupStatus.value = null
    }
}
