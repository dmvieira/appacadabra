package com.example.appacadabra

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.os.Environment
import android.provider.MediaStore
import android.speech.RecognizerIntent
import android.webkit.GeolocationPermissions
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import android.webkit.WebResourceRequest
import android.webkit.ValueCallback
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.DateRange
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.graphics.Color
import androidx.compose.material3.darkColorScheme
import androidx.core.content.ContextCompat
import androidx.room.Room
import com.example.appacadabra.api.GeminiJsInterface
import com.example.appacadabra.api.GeminiModels
import com.example.appacadabra.api.CalendarJsInterface
import com.example.appacadabra.api.GeminiClient
import com.example.appacadabra.api.NotificationJsInterface
import com.example.appacadabra.api.LocalStorageJsInterface
import com.example.appacadabra.data.AppDatabase
import com.example.appacadabra.data.AppVersion
import com.example.appacadabra.utils.CodeExtractor
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class AppRunnerActivity : ComponentActivity() {
    
    private var pendingPermissionRequest: PermissionRequest? = null
    private var pendingGeolocationCallback: GeolocationPermissions.Callback? = null
    private var pendingGeolocationOrigin: String? = null

    private val permissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { permissions ->
        val allGranted = permissions.values.all { it }
        pendingPermissionRequest?.let { request ->
            if (allGranted) {
                request.grant(request.resources)
            } else {
                request.deny()
            }
            pendingPermissionRequest = null
        }
        pendingGeolocationCallback?.let { callback ->
            callback.invoke(pendingGeolocationOrigin, allGranted, false)
            pendingGeolocationCallback = null
            pendingGeolocationOrigin = null
        }
    }
    
    // File chooser handling
    private var fileUploadCallback: ValueCallback<Array<Uri>>? = null
    private var cameraPhotoUri: Uri? = null
    
    private val fileChooserLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        if (result.resultCode == RESULT_OK) {
            val clipData = result.data?.clipData
            val dataUri = result.data?.data
            
            val uris = when {
                clipData != null -> {
                    // Multiple files selected
                    (0 until clipData.itemCount).map { clipData.getItemAt(it).uri }.toTypedArray()
                }
                dataUri != null -> {
                    // Single file selected
                    arrayOf(dataUri)
                }
                cameraPhotoUri != null -> {
                    // Photo taken with camera
                    arrayOf(cameraPhotoUri!!)
                }
                else -> arrayOf()
            }
            
            fileUploadCallback?.onReceiveValue(uris)
        } else {
            // User cancelled
            fileUploadCallback?.onReceiveValue(arrayOf())
        }
        fileUploadCallback = null
        cameraPhotoUri = null
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val appId = intent.getLongExtra("APP_ID", -1)
        val isEditMode = intent.getBooleanExtra("EDIT_MODE", false)
        
        val db = Room.databaseBuilder(
            applicationContext,
            AppDatabase::class.java, "appacadabra-db"
        )
            .addMigrations(AppDatabase.MIGRATION_1_2, AppDatabase.MIGRATION_2_3, AppDatabase.MIGRATION_3_4, AppDatabase.MIGRATION_4_5, AppDatabase.MIGRATION_5_6)
            .build()
            
        val appCode = if (appId != -1L) {
            kotlinx.coroutines.runBlocking { db.appDao().getAppById(appId)?.code }
        } else {
            intent.getStringExtra("APP_CODE")
        }

        setContent {
            MaterialTheme(
                colorScheme = darkColorScheme(
                    primary = Color(0xFF7B2EFF),
                    onPrimary = Color.White,
                    primaryContainer = Color(0xFF2D1B69),
                    onPrimaryContainer = Color(0xFFE8E0FF),
                    secondary = Color(0xFF00F5FF),
                    onSecondary = Color(0xFF0A0A1A),
                    tertiary = Color(0xFFFF2EAB),
                    onTertiary = Color.White,
                    background = Color(0xFF0A0A1A),
                    onBackground = Color(0xFFE8E0FF),
                    surface = Color(0xFF141428),
                    onSurface = Color(0xFFE8E0FF),
                    surfaceVariant = Color(0xFF1E1E3F),
                    onSurfaceVariant = Color(0xFFB8B0D0),
                    error = Color(0xFFFF4B6E),
                    onError = Color.White
                )
            ) {
            if (appCode != null) {
                AppRunnerScreen(
                    htmlContent = appCode,
                    appId = appId,
                    isEditMode = isEditMode,
                    db = db,
                    onPermissionRequest = { request -> handlePermissionRequest(request) },
                    onGeolocationRequest = { origin, callback -> handleGeolocationRequest(origin, callback) },
                    onFileChooserRequest = { callback, acceptType, captureEnabled ->
                        handleFileChooser(callback, acceptType, captureEnabled)
                    }
                )
            }
            }
        }
    }
    
    private fun handlePermissionRequest(request: PermissionRequest) {
        val permissionsToRequest = mutableListOf<String>()
        
        request.resources.forEach { resource ->
            when (resource) {
                PermissionRequest.RESOURCE_AUDIO_CAPTURE -> {
                    if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) 
                        != PackageManager.PERMISSION_GRANTED) {
                        permissionsToRequest.add(Manifest.permission.RECORD_AUDIO)
                    }
                }
                PermissionRequest.RESOURCE_VIDEO_CAPTURE -> {
                    if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) 
                        != PackageManager.PERMISSION_GRANTED) {
                        permissionsToRequest.add(Manifest.permission.CAMERA)
                    }
                }
            }
        }
        
        if (permissionsToRequest.isEmpty()) {
            request.grant(request.resources)
        } else {
            pendingPermissionRequest = request
            permissionLauncher.launch(permissionsToRequest.toTypedArray())
        }
    }
    
    private fun handleGeolocationRequest(origin: String, callback: GeolocationPermissions.Callback) {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) 
            == PackageManager.PERMISSION_GRANTED) {
            callback.invoke(origin, true, false)
        } else {
            pendingGeolocationCallback = callback
            pendingGeolocationOrigin = origin
            permissionLauncher.launch(arrayOf(
                Manifest.permission.ACCESS_FINE_LOCATION,
                Manifest.permission.ACCESS_COARSE_LOCATION
            ))
        }
    }
    
    private fun handleFileChooser(
        callback: ValueCallback<Array<Uri>>,
        acceptType: String,
        captureEnabled: Boolean
    ) {
        fileUploadCallback = callback
        
        val isImageRequest = acceptType.contains("image")
        
        // Create intent for file picker
        val filePickerIntent = Intent(Intent.ACTION_GET_CONTENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = if (acceptType.isNotEmpty()) acceptType else "*/*"
            putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
        }
        
        val intents = mutableListOf<Intent>()
        
        // Add camera intent if it's an image request or capture is enabled
        if (isImageRequest || captureEnabled) {
            try {
                // Create file for camera photo
                val photoDir = File(cacheDir, "camera_photos")
                if (!photoDir.exists()) photoDir.mkdirs()
                
                val timestamp = SimpleDateFormat("yyyyMMdd_HHmmss", Locale.getDefault()).format(Date())
                val photoFile = File(photoDir, "IMG_$timestamp.jpg")
                
                cameraPhotoUri = androidx.core.content.FileProvider.getUriForFile(
                    this,
                    "${packageName}.fileprovider",
                    photoFile
                )
                
                val cameraIntent = Intent(MediaStore.ACTION_IMAGE_CAPTURE).apply {
                    putExtra(MediaStore.EXTRA_OUTPUT, cameraPhotoUri)
                }
                
                // Check if camera app exists
                if (cameraIntent.resolveActivity(packageManager) != null) {
                    intents.add(cameraIntent)
                }
            } catch (e: Exception) {
                e.printStackTrace()
            }
        }
        
        // Create chooser
        val chooserIntent = Intent.createChooser(filePickerIntent, "Selecionar arquivo")
        if (intents.isNotEmpty()) {
            chooserIntent.putExtra(Intent.EXTRA_INITIAL_INTENTS, intents.toTypedArray())
        }
        
        fileChooserLauncher.launch(chooserIntent)
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@SuppressLint("SetJavaScriptEnabled")
@Composable
fun AppRunnerScreen(
    htmlContent: String,
    appId: Long,
    isEditMode: Boolean,
    db: AppDatabase,
    onPermissionRequest: (PermissionRequest) -> Unit,
    onGeolocationRequest: (String, GeolocationPermissions.Callback) -> Unit,
    onFileChooserRequest: (ValueCallback<Array<Uri>>, String, Boolean) -> Unit
) {
    val context = LocalContext.current
    val scope = remember { CoroutineScope(SupervisorJob() + Dispatchers.Main) }
    
    var currentHtml by remember { mutableStateOf(htmlContent) }
    var showEditSheet by remember { mutableStateOf(false) }
    var selectedText by remember { mutableStateOf("") }
    var editPrompt by remember { mutableStateOf("") }
    var isEditing by remember { mutableStateOf(false) }
    var editError by remember { mutableStateOf<String?>(null) }
    var webViewRef by remember { mutableStateOf<WebView?>(null) }
    var showBanner by remember { mutableStateOf(true) }
    
    var showHistorySheet by remember { mutableStateOf(false) }
    var versions by remember { mutableStateOf<List<com.example.appacadabra.data.AppVersion>>(emptyList()) }
    
    // Manual editor states
    var showManualEditor by remember { mutableStateOf(false) }
    var manualEditHtml by remember { mutableStateOf("") }
    var manualEditorTab by remember { mutableStateOf(0) } // 0 = HTML, 1 = Console
    var isSavingManual by remember { mutableStateOf(false) }
    
    // JavaScript console logs for debugging
    var consoleLogs by remember { mutableStateOf<List<String>>(emptyList()) }
    
    // Function to add console log that can be called from the callback
    fun addConsoleLog(log: String) {
        consoleLogs = (consoleLogs + log).takeLast(100) // Keep last 100 logs
    }
    
    // Save console logs to database (for non-edit mode)
    fun saveConsoleLogs() {
        if (!isEditMode && appId != -1L) {
            scope.launch(Dispatchers.IO) {
                try {
                    val app = db.appDao().getAppById(appId)
                    app?.let {
                        val logsJson = consoleLogs.joinToString("\n")
                        val updatedApp = it.copy(consoleLogs = logsJson)
                        db.appDao().updateApp(updatedApp)
                    }
                } catch (e: Exception) {
                    e.printStackTrace()
                }
            }
        }
    }
    
    // Load console logs from database when entering edit mode
    LaunchedEffect(Unit) {
        if (isEditMode && appId != -1L) {
            try {
                val app = withContext(Dispatchers.IO) {
                    db.appDao().getAppById(appId)
                }
                app?.let {
                    val loadedLogs = if (it.consoleLogs.isNotEmpty()) {
                        it.consoleLogs.split("\n")
                    } else {
                        emptyList()
                    }
                    consoleLogs = loadedLogs
                    println("Loaded ${loadedLogs.size} logs from database")
                }
            } catch (e: Exception) {
                e.printStackTrace()
            }
        }
    }
    
    // Save logs when app goes to background or stops (using Lifecycle)
    val activity = context as? androidx.activity.ComponentActivity
    DisposableEffect(activity) {
        val observer = androidx.lifecycle.LifecycleEventObserver { _, event ->
            if (event == androidx.lifecycle.Lifecycle.Event.ON_STOP) {
                if (!isEditMode && consoleLogs.isNotEmpty() && appId != -1L) {
                    // Save logs when app stops
                    scope.launch(Dispatchers.IO) {
                        try {
                            val app = db.appDao().getAppById(appId)
                            app?.let {
                                val logsJson = consoleLogs.joinToString("\n")
                                val updatedApp = it.copy(consoleLogs = logsJson)
                                db.appDao().updateApp(updatedApp)
                                println("Saved ${consoleLogs.size} logs to database on STOP")
                            }
                        } catch (e: Exception) {
                            e.printStackTrace()
                        }
                    }
                }
            }
        }
        activity?.lifecycle?.addObserver(observer)
        onDispose {
            activity?.lifecycle?.removeObserver(observer)
        }
    }
    
    fun loadVersions() {
        scope.launch(Dispatchers.IO) {
            val history = db.appDao().getVersionsForApp(appId)
            withContext(Dispatchers.Main) {
                versions = history
            }
        }
    }
    
    fun restoreVersion(version: com.example.appacadabra.data.AppVersion) {
        scope.launch {
            currentHtml = version.code
            webViewRef?.loadDataWithBaseURL("https://localhost/", version.code, "text/html", "UTF-8", null)
            try {
                withContext(Dispatchers.IO) {
                    val app = db.appDao().getAppById(appId)
                    app?.let {
                        // Simply switch to the version without creating a new one
                        val updatedApp = it.copy(
                            code = version.code,
                            currentVersion = version.version,
                            lastUpdated = System.currentTimeMillis()
                        )
                        db.appDao().updateApp(updatedApp)
                    }
                }
                // Reload versions list to reflect the new current version
                loadVersions()
            } catch (e: Exception) {
                e.printStackTrace()
            }
        }
    }
    
    fun saveManualEdit() {
        if (manualEditHtml.isBlank() || manualEditHtml == currentHtml) return
        
        isSavingManual = true
        scope.launch {
            try {
                val newCode = manualEditHtml
                
                if (appId != -1L) {
                    withContext(Dispatchers.IO) {
                        val app = db.appDao().getAppById(appId)
                        app?.let {
                            val newVersion = it.currentVersion + 1
                            val updatedApp = it.copy(
                                code = newCode,
                                currentVersion = newVersion,
                                lastUpdated = System.currentTimeMillis()
                            )
                            db.appDao().updateApp(updatedApp)
                            db.appDao().insertVersion(AppVersion(
                                appId = appId,
                                version = newVersion,
                                code = newCode,
                                instruction = "Edição manual",
                                createdAt = System.currentTimeMillis()
                            ))
                        }
                    }
                }
                
                currentHtml = newCode
                webViewRef?.loadDataWithBaseURL("https://localhost/", newCode, "text/html", "UTF-8", null)
                
                showManualEditor = false
                manualEditHtml = ""
                
            } catch (e: Exception) {
                e.printStackTrace()
            } finally {
                isSavingManual = false
            }
        }
    }
    
    // Speech recognizer launcher
    val speechLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.StartActivityForResult()
    ) { result ->
        if (result.resultCode == android.app.Activity.RESULT_OK) {
            val spokenText = result.data?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)?.firstOrNull()
            spokenText?.let { 
                editPrompt = if (editPrompt.isNotEmpty()) "$editPrompt $it" else it
            }
        }
    }
    
    fun startSpeechRecognition() {
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.getDefault())
            putExtra(RecognizerIntent.EXTRA_PROMPT, "Fale o que deseja alterar...")
        }
        try {
            speechLauncher.launch(intent)
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }
    
    // Enable element selection mode via JavaScript
    fun enableElementSelection() {
        val js = """
            (function() {
                // Remove previous selection highlight
                if (window._appacadabraSelectedElement) {
                    window._appacadabraSelectedElement.style.outline = window._appacadabraPreviousOutline || '';
                }
                window._appacadabraSelectedElement = null;
                window._appacadabraSelectedHtml = '';
                window._appacadabraEditMode = true;
                
                // Remove old listener if exists
                if (window._appacadabraClickHandler) {
                    document.body.removeEventListener('click', window._appacadabraClickHandler, true);
                }
                
                // Create and store new click handler
                window._appacadabraClickHandler = function(e) {
                    if (!window._appacadabraEditMode) return;
                    
                    e.preventDefault();
                    e.stopPropagation();
                    
                    // Remove previous selection highlight
                    if (window._appacadabraSelectedElement) {
                        window._appacadabraSelectedElement.style.outline = window._appacadabraPreviousOutline || '';
                    }
                    
                    // Store new selection
                    window._appacadabraSelectedElement = e.target;
                    window._appacadabraPreviousOutline = e.target.style.outline;
                    
                    // IMPORTANT: Store the HTML BEFORE adding the selection outline
                    window._appacadabraSelectedHtml = e.target.outerHTML;
                    window._appacadabraSelectedTag = e.target.tagName;
                    
                    // Now add the selection highlight
                    e.target.style.outline = '3px solid #4CAF50';
                };
                
                // Add click handler
                document.body.addEventListener('click', window._appacadabraClickHandler, true);
                
                console.log('Appacadabra edit mode enabled');
            })();
        """.trimIndent()
        webViewRef?.evaluateJavascript(js, null)
    }
    
    fun disableElementSelection() {
        val js = """
            (function() {
                window._appacadabraEditMode = false;
                if (window._appacadabraSelectedElement) {
                    window._appacadabraSelectedElement.style.outline = window._appacadabraPreviousOutline || '';
                    window._appacadabraSelectedElement = null;
                }
            })();
        """.trimIndent()
        webViewRef?.evaluateJavascript(js, null)
    }
    
    fun getSelectedContent() {
        // Get both text selection AND clicked element
        val js = """
            (function() {
                var textSelection = window.getSelection().toString();
                var elementHtml = window._appacadabraSelectedHtml || '';
                var elementTag = window._appacadabraSelectedTag || '';
                
                if (textSelection && textSelection.length > 0) {
                    return JSON.stringify({type: 'text', content: textSelection});
                } else if (elementHtml && elementHtml.length > 0) {
                    return JSON.stringify({type: 'element', content: elementHtml, tag: elementTag});
                } else {
                    return JSON.stringify({type: 'none', content: ''});
                }
            })();
        """.trimIndent()
        
        webViewRef?.evaluateJavascript(js) { result ->
            try {
                // JavaScript result comes wrapped in quotes and escaped
                // Remove outer quotes first
                var cleanResult = result ?: "{}"
                if (cleanResult.startsWith("\"") && cleanResult.endsWith("\"")) {
                    cleanResult = cleanResult.substring(1, cleanResult.length - 1)
                }
                // Unescape the JSON string
                cleanResult = cleanResult
                    .replace("\\\"", "\"")
                    .replace("\\\\", "\\")
                    .replace("\\n", "\n")
                    .replace("\\r", "\r")
                    .replace("\\t", "\t")
                
                val json = org.json.JSONObject(cleanResult)
                val type = json.optString("type", "none")
                val content = json.optString("content", "")
                
                selectedText = when (type) {
                    "element" -> {
                        val tag = json.optString("tag", "")
                        "[HTML $tag]\n$content"
                    }
                    "text" -> content
                    else -> ""
                }
                showEditSheet = true
            } catch (e: Exception) {
                e.printStackTrace()
                selectedText = ""
                showEditSheet = true
            }
        }
    }
    
    // Enable element selection when in edit mode
    LaunchedEffect(isEditMode) {
        if (isEditMode) {
            enableElementSelection()
        }
    }
    
    fun applyEdit() {
        if (editPrompt.isBlank()) return
        
        isEditing = true
        scope.launch {
            try {
                // Get previous versions to build context
                val previousVersions = if (appId != -1L) {
                    withContext(Dispatchers.IO) {
                        db.appDao().getVersionsForApp(appId)
                    }
                } else emptyList()
                
                // Summarize previous edits if there are any with instructions
                val editHistory = previousVersions
                    .filter { !it.instruction.isNullOrBlank() }
                    .sortedBy { it.version }
                    .takeLast(10) // Limit to last 10 edits
                
                val historyContext = if (editHistory.isNotEmpty()) {
                    // Build a summary of previous edits
                    val historyItems = editHistory.mapIndexed { index, ver ->
                        val context = ver.selectedContext?.take(100)?.let { "[Context: $it]" } ?: ""
                        "- v${ver.version}: ${ver.instruction} $context"
                    }.joinToString("\n")
                    
                    """
IMPORTANT - Previous edits made to this app (DO NOT UNDO these changes):
$historyItems

Make sure your new edit PRESERVES all the functionality and changes from previous versions.
"""
                } else ""
                
                val prompt = if (selectedText.isNotBlank()) {
                    """Here is an HTML application:
```html
$currentHtml
```
$historyContext
The user selected this specific part of the code:
"$selectedText"

Please modify ONLY this selected part according to the user's instructions: $editPrompt

Return the COMPLETE updated HTML code with only the selected part modified. Wrap it in ```html ... ```.
"""
                } else {
                    """Here is an HTML application:
```html
$currentHtml
```
$historyContext
Please modify it according to these instructions: $editPrompt

Return the COMPLETE updated HTML code. Wrap it in ```html ... ```.
"""
                }
                
                
                val newCode = withContext(Dispatchers.IO) {
                    try {
                        // Try primary model first
                        val response = GeminiModels.primary.generateContent(prompt)
                        response.text?.let { CodeExtractor.extractHtml(it) } ?: currentHtml
                    } catch (e: Exception) {
                        // If rate limit error, try fallback model
                        if (GeminiModels.isRateLimitError(e)) {
                            println("Rate limit hit on primary model, trying fallback...")
                            val fallbackResponse = GeminiModels.fallback.generateContent(prompt)
                            fallbackResponse.text?.let { CodeExtractor.extractHtml(it) } ?: currentHtml
                        } else {
                            throw e
                        }
                    }
                }
                
                // Save to database with instruction and context
                if (appId != -1L) {
                    withContext(Dispatchers.IO) {
                        val app = db.appDao().getAppById(appId)
                        app?.let {
                            val newVersion = it.currentVersion + 1
                            val updatedApp = it.copy(
                                code = newCode,
                                currentVersion = newVersion,
                                lastUpdated = System.currentTimeMillis()
                            )
                            db.appDao().updateApp(updatedApp)
                            db.appDao().insertVersion(AppVersion(
                                appId = appId,
                                version = newVersion,
                                code = newCode,
                                instruction = editPrompt,
                                selectedContext = selectedText.takeIf { it.isNotBlank() }
                            ))
                        }
                    }
                }
                
                currentHtml = newCode
                webViewRef?.loadDataWithBaseURL("https://localhost/", newCode, "text/html", "UTF-8", null)
                
                // Re-enable element selection after content reload
                webViewRef?.postDelayed({
                    if (isEditMode) {
                        enableElementSelection()
                    }
                }, 500)
                
                showEditSheet = false
                editPrompt = ""
                selectedText = ""
                editError = null
                
            } catch (e: Exception) {
                e.printStackTrace()
                editError = "Erro ao editar: ${e.message ?: "Erro desconhecido"}"
            } finally {
                isEditing = false
            }
        }
    }
    
    Box(modifier = Modifier.fillMaxSize()) {
        // WebView
        AndroidView(
            factory = { ctx ->
                WebView(ctx).apply {
                    webViewRef = this
                    settings.javaScriptEnabled = true
                    settings.domStorageEnabled = true
                    settings.cacheMode = android.webkit.WebSettings.LOAD_NO_CACHE
                    settings.mediaPlaybackRequiresUserGesture = false
                    settings.allowFileAccess = true
                    settings.javaScriptCanOpenWindowsAutomatically = true
                    
                    // Clear cache to ensure fresh content
                    clearCache(true)
                    
                    // Add Gemini AI JavaScript interface
                    addJavascriptInterface(GeminiJsInterface(this, scope), "AppacadabraAI")
                    
                    // Add Calendar JavaScript interface
                    addJavascriptInterface(
                        CalendarJsInterface(
                            context = ctx,
                            webView = this,
                            scope = scope,
                            requestPermission = {
                                // Request calendar permissions
                                val activity = ctx as? android.app.Activity
                                activity?.let {
                                    androidx.core.app.ActivityCompat.requestPermissions(
                                        it,
                                        arrayOf(android.Manifest.permission.WRITE_CALENDAR, android.Manifest.permission.READ_CALENDAR),
                                        1001
                                    )
                                }
                            }
                        ),
                        "AppacadabraCalendar"
                    )
                    
                    // Add Notification JavaScript interface
                    addJavascriptInterface(
                        NotificationJsInterface(
                            context = ctx,
                            webView = this,
                            scope = scope,
                            requestPermission = {
                                if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.TIRAMISU) {
                                    val activity = ctx as? android.app.Activity
                                    activity?.let {
                                        androidx.core.app.ActivityCompat.requestPermissions(
                                            it,
                                            arrayOf(android.Manifest.permission.POST_NOTIFICATIONS),
                                            1002
                                        )
                                    }
                                }
                            }
                        ),
                        "AppacadabraNotify"
                    )
                    
                    // Add LocalStorage JavaScript interface for persistence
                    addJavascriptInterface(
                        LocalStorageJsInterface(appId, db.appDao(), scope),
                        "AppStorage"
                    )
                    
                    // WebChromeClient for permissions and file chooser
                    webChromeClient = object : WebChromeClient() {
                        override fun onPermissionRequest(request: PermissionRequest) {
                            onPermissionRequest(request)
                        }
                        
                        override fun onGeolocationPermissionsShowPrompt(
                            origin: String,
                            callback: GeolocationPermissions.Callback
                        ) {
                            onGeolocationRequest(origin, callback)
                        }
                        
                        override fun onShowFileChooser(
                            webView: WebView?,
                            filePathCallback: ValueCallback<Array<Uri>>?,
                            fileChooserParams: FileChooserParams?
                        ): Boolean {
                            filePathCallback?.let { callback ->
                                val acceptTypes = fileChooserParams?.acceptTypes?.joinToString(",") ?: "*/*"
                                val isCaptureEnabled = fileChooserParams?.isCaptureEnabled ?: false
                                onFileChooserRequest(callback, acceptTypes, isCaptureEnabled)
                            }
                            return true
                        }
                        
                        override fun onConsoleMessage(consoleMessage: android.webkit.ConsoleMessage?): Boolean {
                            consoleMessage?.let { msg ->
                                val prefix = when (msg.messageLevel()) {
                                    android.webkit.ConsoleMessage.MessageLevel.ERROR -> "[ERROR]"
                                    android.webkit.ConsoleMessage.MessageLevel.WARNING -> "[WARN]"
                                    else -> "[LOG]"
                                }
                                val logEntry = "$prefix ${msg.message()} (${msg.sourceId()}:${msg.lineNumber()})"
                                addConsoleLog(logEntry)
                            }
                            return true
                        }
                    }
                    
                    // Custom WebViewClient to handle external links and network logging
                    webViewClient = object : WebViewClient() {
                        override fun shouldInterceptRequest(
                            view: WebView?,
                            request: android.webkit.WebResourceRequest?
                        ): android.webkit.WebResourceResponse? {
                            // Log network requests to console
                            request?.let { req ->
                                val method = if (req.method != null) req.method else "GET"
                                val logEntry = "[NET] $method ${req.url}"
                                addConsoleLog(logEntry)
                            }
                            return super.shouldInterceptRequest(view, request)
                        }
                        
                        override fun onPageFinished(view: WebView?, url: String?) {
                            super.onPageFinished(view, url)
                            
                            // Inject localStorage bridge
                            view?.evaluateJavascript(LocalStorageJsInterface.getInitScript(), null)
                            
                            // Re-inject edit mode JS when page loads
                            if (isEditMode) {
                                view?.postDelayed({
                                    enableElementSelection()
                                }, 300)
                            }
                        }
                        
                        override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                            val url = request?.url?.toString() ?: return false
                            
                            // Check if it's an external link (not our local content)
                            if (url.startsWith("http://") || url.startsWith("https://")) {
                                // Check if it's a known app link (YouTube, etc.)
                                val isExternalApp = url.contains("youtube.com") || 
                                                   url.contains("youtu.be") ||
                                                   url.contains("twitter.com") ||
                                                   url.contains("x.com") ||
                                                   url.contains("instagram.com") ||
                                                   url.contains("facebook.com") ||
                                                   url.contains("tiktok.com") ||
                                                   url.contains("spotify.com") ||
                                                   url.contains("maps.google.com") ||
                                                   url.contains("play.google.com") ||
                                                   url.contains("whatsapp.com") ||
                                                   url.contains("telegram.org")
                                
                                // Explicitly intercept Google Calendar
                                if (url.contains("calendar.google.com") || url.contains("google.com/calendar")) {
                                    try {
                                        // Attempt to parse simple parameters (naive approach)
                                        // or just open the Calendar App using Intent.ACTION_INSERT
                                        val intent = Intent(Intent.ACTION_INSERT).apply {
                                            data = android.provider.CalendarContract.Events.CONTENT_URI
                                            
                                            // Extract parameters if present (Google Calendar web link format)
                                            try {
                                                val uri = Uri.parse(url)
                                                uri.getQueryParameter("text")?.let { putExtra(android.provider.CalendarContract.Events.TITLE, it) }
                                                uri.getQueryParameter("details")?.let { putExtra(android.provider.CalendarContract.Events.DESCRIPTION, it) }
                                                uri.getQueryParameter("location")?.let { putExtra(android.provider.CalendarContract.Events.EVENT_LOCATION, it) }
                                            } catch (e: Exception) {
                                                e.printStackTrace()
                                            }
                                        }
                                        ctx.startActivity(intent)
                                        return true
                                    } catch (e: Exception) {
                                        e.printStackTrace()
                                    }
                                }

                                
                                if (isExternalApp) {
                                    // Open in external app
                                    try {
                                        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url))
                                        ctx.startActivity(intent)
                                        return true
                                    } catch (e: Exception) {
                                        // If no app can handle it, let WebView load it
                                        return false
                                    }
                                }
                            }
                            
                            // For other URLs, load in WebView
                            return false
                        }
                    }
                    
                    loadDataWithBaseURL("https://localhost/", currentHtml, "text/html", "UTF-8", null)
                }
            },
            update = { webView ->
                webViewRef = webView
            },
            modifier = Modifier.fillMaxSize()
        )
        
        // Edit mode UI - instruction banner at top (dismissible)
        if (isEditMode && showBanner) {
            Surface(
                onClick = { showBanner = false },
                modifier = Modifier
                    .align(Alignment.TopCenter)
                    .fillMaxWidth()
                    .padding(horizontal = 16.dp, vertical = 8.dp),
                color = MaterialTheme.colorScheme.primaryContainer,
                shape = RoundedCornerShape(8.dp)
            ) {
                Row(
                    modifier = Modifier.padding(12.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Text(
                        text = "🎯 Clique em um elemento para selecioná-lo, ou em \"Editar\" para modificar tudo. Toque aqui para fechar.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onPrimaryContainer,
                        modifier = Modifier.weight(1f)
                    )
                    Text("✕", style = MaterialTheme.typography.titleMedium)
                }
            }
        }
        
        // Floating buttons
        Column(
            modifier = Modifier
                .align(Alignment.BottomEnd)
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            // Home button (always visible)
            FloatingActionButton(
                onClick = {
                    val intent = Intent(context, MainActivity::class.java).apply {
                        flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
                    }
                    context.startActivity(intent)
                },
                modifier = Modifier.size(48.dp),
                shape = CircleShape
            ) {
                Icon(Icons.Default.Home, contentDescription = "Back to Appacadabra")
            }
        }
        
        // Edit button (only in edit mode, left side)
        if (isEditMode) {
            // Manual editor button
            FloatingActionButton(
                onClick = { 
                    manualEditHtml = currentHtml
                    showManualEditor = true 
                },
                modifier = Modifier
                    .align(Alignment.BottomStart)
                    .padding(bottom = 144.dp, start = 16.dp),
                containerColor = MaterialTheme.colorScheme.tertiaryContainer
            ) {
                Text("</>", style = MaterialTheme.typography.labelLarge)
            }
            
            // History button
            FloatingActionButton(
                onClick = { 
                    loadVersions()
                    showHistorySheet = true 
                },
                modifier = Modifier
                    .align(Alignment.BottomStart)
                    .padding(bottom = 80.dp, start = 16.dp),
                containerColor = MaterialTheme.colorScheme.secondaryContainer
            ) {
                Icon(Icons.Filled.DateRange, contentDescription = "Histórico")
            }

            FloatingActionButton(
                onClick = { getSelectedContent() },
                modifier = Modifier
                    .align(Alignment.BottomStart)
                    .padding(16.dp),
                containerColor = MaterialTheme.colorScheme.primary
            ) {
                Row(
                    modifier = Modifier.padding(horizontal = 16.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    Text("✏️")
                    Text("Editar", style = MaterialTheme.typography.labelLarge)
                }
            }
        }
    }
    
    // Edit Bottom Sheet
    if (showEditSheet) {
        ModalBottomSheet(
            onDismissRequest = { 
                showEditSheet = false 
                editPrompt = ""
                selectedText = ""
            }
        ) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(16.dp)
            ) {
                Text(
                    text = if (selectedText.isNotBlank()) "Editando seleção" else "Editar app inteiro",
                    style = MaterialTheme.typography.titleLarge
                )
                
                if (selectedText.isNotBlank()) {
                    Spacer(modifier = Modifier.height(8.dp))
                    Surface(
                        color = MaterialTheme.colorScheme.surfaceVariant,
                        shape = RoundedCornerShape(8.dp),
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Text(
                            text = selectedText.take(200) + if (selectedText.length > 200) "..." else "",
                            style = MaterialTheme.typography.bodySmall,
                            modifier = Modifier.padding(8.dp)
                        )
                    }
                }
                
                Spacer(modifier = Modifier.height(16.dp))
                
                OutlinedTextField(
                    value = editPrompt,
                    onValueChange = { editPrompt = it },
                    label = { Text("O que deseja alterar?") },
                    modifier = Modifier.fillMaxWidth(),
                    minLines = 2,
                    trailingIcon = {
                        IconButton(onClick = { startSpeechRecognition() }) {
                            Text("🎤", style = MaterialTheme.typography.titleLarge)
                        }
                    }
                )
                
                Spacer(modifier = Modifier.height(16.dp))
                
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    OutlinedButton(
                        onClick = { 
                            showEditSheet = false
                            editPrompt = ""
                            selectedText = ""
                        },
                        modifier = Modifier.weight(1f)
                    ) {
                        Text("Cancelar")
                    }
                    
                    Button(
                        onClick = { applyEdit() },
                        modifier = Modifier.weight(1f),
                        enabled = editPrompt.isNotBlank() && !isEditing
                    ) {
                        if (isEditing) {
                            CircularProgressIndicator(
                                modifier = Modifier.size(20.dp),
                                strokeWidth = 2.dp
                            )
                        } else {
                            Text("Aplicar")
                        }
                    }
                }
                
                // Show error if any
                if (editError != null) {
                    Spacer(modifier = Modifier.height(8.dp))
                    Surface(
                        color = MaterialTheme.colorScheme.errorContainer,
                        shape = RoundedCornerShape(8.dp),
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Text(
                            text = editError!!,
                            color = MaterialTheme.colorScheme.onErrorContainer,
                            style = MaterialTheme.typography.bodySmall,
                            modifier = Modifier.padding(12.dp)
                        )
                    }
                }
                
                Spacer(modifier = Modifier.height(32.dp))
            }
        }
    }
    
    // History Sheet
    if (showHistorySheet) {
        ModalBottomSheet(onDismissRequest = { showHistorySheet = false }) {
            Column(modifier = Modifier.padding(16.dp)) {
                Text(
                    "Histórico de Versões",
                    style = MaterialTheme.typography.titleLarge
                )
                Spacer(modifier = Modifier.height(16.dp))
                
                if (versions.isEmpty()) {
                    Text("Nenhuma versão anterior encontrada.", modifier = Modifier.padding(16.dp))
                } else {
                    androidx.compose.foundation.lazy.LazyColumn {
                        items(versions.size) { index ->
                            val version = versions[index]
                            Card(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(vertical = 4.dp),
                                onClick = {
                                    restoreVersion(version)
                                    showHistorySheet = false
                                }
                            ) {
                                Column(modifier = Modifier.padding(12.dp)) {
                                    Row(
                                        modifier = Modifier.fillMaxWidth(),
                                        horizontalArrangement = Arrangement.SpaceBetween
                                    ) {
                                        Text(
                                            "Versão ${version.version}",
                                            style = MaterialTheme.typography.titleMedium,
                                            fontWeight = androidx.compose.ui.text.font.FontWeight.Bold
                                        )
                                        Text(
                                            java.text.SimpleDateFormat("dd/MM HH:mm", Locale.getDefault())
                                                .format(java.util.Date(version.createdAt)),
                                            style = MaterialTheme.typography.bodySmall
                                        )
                                    }
                                    if (!version.instruction.isNullOrBlank()) {
                                        Text(
                                            "📝 ${version.instruction}",
                                            style = MaterialTheme.typography.bodyMedium,
                                            maxLines = 2
                                        )
                                    }
                                }
                            }
                        }
                    }
                }
                Spacer(modifier = Modifier.height(32.dp))
            }
        }
    }
    
    // Manual Editor Sheet
    if (showManualEditor) {
        ModalBottomSheet(
            onDismissRequest = { 
                showManualEditor = false 
                manualEditHtml = ""
            },
            modifier = Modifier.fillMaxHeight(0.9f)
        ) {
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(16.dp)
            ) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Text(
                        "Editor Manual",
                        style = MaterialTheme.typography.titleLarge
                    )
                    
                    // Tab selector
                    Row(
                        horizontalArrangement = Arrangement.spacedBy(8.dp)
                    ) {
                        FilterChip(
                            selected = manualEditorTab == 0,
                            onClick = { manualEditorTab = 0 },
                            label = { Text("HTML") }
                        )
                        FilterChip(
                            selected = manualEditorTab == 1,
                            onClick = { manualEditorTab = 1 },
                            label = { Text("🐛 Console") }
                        )
                    }
                }
                
                Spacer(modifier = Modifier.height(16.dp))
                
                when (manualEditorTab) {
                    0 -> {
                        // HTML Editor
                        OutlinedTextField(
                            value = manualEditHtml,
                            onValueChange = { manualEditHtml = it },
                            modifier = Modifier
                                .fillMaxWidth()
                                .weight(1f),
                            textStyle = MaterialTheme.typography.bodySmall.copy(
                                fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace
                            ),
                            label = { Text("Código HTML") },
                            placeholder = { Text("Edite o código HTML diretamente...") }
                        )
                    }
                    1 -> {
                        // JavaScript Console for debugging
                        Surface(
                            modifier = Modifier
                                .fillMaxWidth()
                                .weight(1f),
                            shape = RoundedCornerShape(8.dp),
                            color = MaterialTheme.colorScheme.surfaceVariant
                        ) {
                            Column {
                                // Console header with clear button
                                Row(
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .padding(8.dp),
                                    horizontalArrangement = Arrangement.SpaceBetween,
                                    verticalAlignment = Alignment.CenterVertically
                                ) {
                                    Text(
                                        "Console JavaScript",
                                        style = MaterialTheme.typography.labelMedium
                                    )
                                    TextButton(onClick = { consoleLogs = emptyList() }) {
                                        Text("🗑️ Limpar")
                                    }
                                }
                                
                                // Console logs list
                                if (consoleLogs.isEmpty()) {
                                    Box(
                                        modifier = Modifier
                                            .fillMaxWidth()
                                            .weight(1f),
                                        contentAlignment = Alignment.Center
                                    ) {
                                        Column(horizontalAlignment = Alignment.CenterHorizontally) {
                                            Text("📋", style = MaterialTheme.typography.headlineLarge)
                                            Spacer(modifier = Modifier.height(8.dp))
                                            Text(
                                                "Nenhum log ainda",
                                                style = MaterialTheme.typography.bodyMedium,
                                                color = MaterialTheme.colorScheme.onSurfaceVariant
                                            )
                                            Text(
                                                "Execute o app para ver console.log()",
                                                style = MaterialTheme.typography.bodySmall,
                                                color = MaterialTheme.colorScheme.onSurfaceVariant
                                            )
                                        }
                                    }
                                } else {
                                    androidx.compose.foundation.lazy.LazyColumn(
                                        modifier = Modifier
                                            .fillMaxWidth()
                                            .weight(1f)
                                            .padding(horizontal = 8.dp),
                                        reverseLayout = true
                                    ) {
                                        items(consoleLogs.size) { index ->
                                            val log = consoleLogs[consoleLogs.size - 1 - index]
                                            val isError = log.startsWith("[ERROR]")
                                            val isWarn = log.startsWith("[WARN]")
                                            
                                            Surface(
                                                modifier = Modifier
                                                    .fillMaxWidth()
                                                    .padding(vertical = 2.dp),
                                                shape = RoundedCornerShape(4.dp),
                                                color = when {
                                                    isError -> MaterialTheme.colorScheme.errorContainer.copy(alpha = 0.5f)
                                                    isWarn -> MaterialTheme.colorScheme.tertiaryContainer.copy(alpha = 0.5f)
                                                    else -> MaterialTheme.colorScheme.surface
                                                }
                                            ) {
                                                Text(
                                                    text = log,
                                                    style = MaterialTheme.typography.bodySmall.copy(
                                                        fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace
                                                    ),
                                                    modifier = Modifier.padding(8.dp),
                                                    color = when {
                                                        isError -> MaterialTheme.colorScheme.error
                                                        isWarn -> MaterialTheme.colorScheme.tertiary
                                                        else -> MaterialTheme.colorScheme.onSurface
                                                    }
                                                )
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                
                Spacer(modifier = Modifier.height(16.dp))
                
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    OutlinedButton(
                        onClick = { 
                            showManualEditor = false
                            manualEditHtml = ""
                        },
                        modifier = Modifier.weight(1f)
                    ) {
                        Text("Cancelar")
                    }
                    
                    Button(
                        onClick = { saveManualEdit() },
                        modifier = Modifier.weight(1f),
                        enabled = manualEditHtml.isNotBlank() && manualEditHtml != currentHtml && !isSavingManual
                    ) {
                        if (isSavingManual) {
                            CircularProgressIndicator(
                                modifier = Modifier.size(20.dp),
                                strokeWidth = 2.dp
                            )
                        } else {
                            Text("💾 Salvar Versão")
                        }
                    }
                }
                
                Spacer(modifier = Modifier.height(16.dp))
            }
        }
    }
}
