package com.example.appacadabra

import android.content.Intent
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.appacadabra.data.GeneratedApp
import com.example.appacadabra.data.AppVersion
import com.example.appacadabra.ui.MainViewModel
import com.example.appacadabra.utils.ShortcutHelper
import kotlinx.coroutines.launch
import java.io.File
import java.io.FileOutputStream

class MainActivity : ComponentActivity() {
    
    private val viewModel: MainViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        
        setContent {
            AppacadabraTheme {
                MainScreen(viewModel) { app ->
                    val intent = Intent(this, AppRunnerActivity::class.java).apply {
                        putExtra("APP_CODE", app.code)
                        putExtra("APP_ID", app.id)
                        addFlags(Intent.FLAG_ACTIVITY_NEW_DOCUMENT)
                    }
                    startActivity(intent)
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MainScreen(viewModel: MainViewModel, onRunApp: (GeneratedApp) -> Unit) {
    val appsState by viewModel.appsState.collectAsState()
    val isGenerating by viewModel.isGenerating.collectAsState()
    val context = LocalContext.current
    var showCreateDialog by remember { mutableStateOf(false) }
    var editingApp by remember { mutableStateOf<GeneratedApp?>(null) }

    var showMenu by remember { mutableStateOf(false) }

    val chatError by viewModel.chatError.collectAsState()
    val backupStatus by viewModel.backupStatus.collectAsState()
    val snackbarHostState = remember { SnackbarHostState() }
    
    // Update dynamic shortcuts
    LaunchedEffect(appsState) {
        val state = appsState
        if (state is com.example.appacadabra.ui.AppsUiState.Success && state.apps.isNotEmpty()) {
            ShortcutHelper.updateDynamicShortcuts(context, state.apps)
        }
    }
    
    val backupLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.CreateDocument("application/json")
    ) { uri: Uri? -> uri?.let { viewModel.exportBackup(it) } }
    
    val restoreLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.OpenDocument()
    ) { uri: Uri? -> uri?.let { viewModel.importBackup(it) } }

    LaunchedEffect(chatError) { chatError?.let { snackbarHostState.showSnackbar(it) } }
    LaunchedEffect(backupStatus) {
        backupStatus?.let {
            snackbarHostState.showSnackbar(it)
            viewModel.clearBackupStatus()
        }
    }
    


    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(
                Brush.verticalGradient(
                    colors = listOf(
                        MaterialTheme.colorScheme.background,
                        MaterialTheme.colorScheme.surface
                    )
                )
            )
    ) {
        Scaffold(
            containerColor = Color.Transparent,
            topBar = { 
                CenterAlignedTopAppBar(
                    title = {
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(8.dp)
                        ) {
                            Text("✨", fontSize = 28.sp)
                            Text(
                                "Appacadabra",
                                fontWeight = FontWeight.Bold,
                                color = MaterialTheme.colorScheme.primary
                            )
                        }
                    },
                    actions = {
                        IconButton(onClick = { showMenu = true }) {
                            Icon(
                                Icons.Default.MoreVert,
                                contentDescription = "Menu",
                                tint = MaterialTheme.colorScheme.onSurface
                            )
                        }
                        DropdownMenu(
                            expanded = showMenu,
                            onDismissRequest = { showMenu = false }
                        ) {
                            DropdownMenuItem(
                                text = { Text("📤 Exportar Apps") },
                                onClick = {
                                    showMenu = false
                                    backupLauncher.launch("appacadabra_backup_${System.currentTimeMillis()}.json")
                                }
                            )
                            DropdownMenuItem(
                                text = { Text("📥 Importar Apps") },
                                onClick = {
                                    showMenu = false
                                    restoreLauncher.launch(arrayOf("application/json"))
                                }
                            )
                        }
                    },
                    colors = TopAppBarDefaults.centerAlignedTopAppBarColors(
                        containerColor = Color.Transparent
                    )
                )
            },
            snackbarHost = { SnackbarHost(snackbarHostState) },
            floatingActionButton = {
                ExtendedFloatingActionButton(
                    onClick = { showCreateDialog = true },
                    containerColor = MaterialTheme.colorScheme.primary,
                    contentColor = MaterialTheme.colorScheme.onPrimary,
                    shape = RoundedCornerShape(16.dp)
                ) {
                    Text("✨", fontSize = 20.sp)
                    Spacer(modifier = Modifier.width(8.dp))
                    Text("Criar App", fontWeight = FontWeight.SemiBold)
                }
            }
        ) { padding ->
            when (val state = appsState) {
                is com.example.appacadabra.ui.AppsUiState.Loading -> {
                    Box(
                        modifier = Modifier
                            .fillMaxSize()
                            .padding(padding),
                        contentAlignment = Alignment.Center
                    ) {
                        CircularProgressIndicator(color = MaterialTheme.colorScheme.primary)
                    }
                }
                is com.example.appacadabra.ui.AppsUiState.Success -> {
                    val apps = state.apps
                    if (apps.isEmpty() && !isGenerating) {
                        // Empty state with onboarding
                        Column(
                            modifier = Modifier
                                .fillMaxSize()
                                .padding(padding)
                                .padding(32.dp),
                            horizontalAlignment = Alignment.CenterHorizontally,
                            verticalArrangement = Arrangement.Center
                        ) {
                            Text("🪄", fontSize = 72.sp)
                            Spacer(modifier = Modifier.height(24.dp))
                            Text(
                                "Crie apps com magia!",
                                style = MaterialTheme.typography.headlineMedium,
                                fontWeight = FontWeight.Bold,
                                color = MaterialTheme.colorScheme.primary
                            )
                            Spacer(modifier = Modifier.height(16.dp))
                            Text(
                                "Descreva o app perfeito para você e a IA cria algo 100% personalizado às suas necessidades.",
                                style = MaterialTheme.typography.bodyLarge,
                                textAlign = TextAlign.Center,
                                color = MaterialTheme.colorScheme.onSurface
                            )
                            Spacer(modifier = Modifier.height(32.dp))
                            
                            // How it works
                            Card(
                                modifier = Modifier.fillMaxWidth(),
                                colors = CardDefaults.cardColors(
                                    containerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.7f)
                                ),
                                shape = RoundedCornerShape(16.dp)
                            ) {
                                Column(modifier = Modifier.padding(20.dp)) {
                                    Text(
                                        "Como funciona:",
                                        style = MaterialTheme.typography.titleMedium,
                                        fontWeight = FontWeight.SemiBold,
                                        color = MaterialTheme.colorScheme.onSurface
                                    )
                                    Spacer(modifier = Modifier.height(12.dp))
                                    
                                    OnboardingStep("1", "Descreva", "Diga exatamente o que você precisa")
                                    OnboardingStep("2", "Personalize", "A IA cria sob medida para você")
                                    OnboardingStep("3", "Use agora", "Seu app funciona instantaneamente")
                                    OnboardingStep("4", "Evolua", "Peça mudanças e melhorias")
                                }
                            }
                        }
                    } else {
                        LazyColumn(
                            modifier = Modifier.padding(padding),
                            contentPadding = PaddingValues(16.dp),
                            verticalArrangement = Arrangement.spacedBy(12.dp)
                        ) {
                            item {
                                Text(
                                    "Seus Apps",
                                    style = MaterialTheme.typography.titleLarge,
                                    fontWeight = FontWeight.SemiBold,
                                    modifier = Modifier.padding(bottom = 8.dp)
                                )
                            }
                            items(apps, key = { it.id }) { currentApp ->
                                val itemContext = LocalContext.current
                                AppItem(
                                    app = currentApp,
                                    onRun = { onRunApp(currentApp) },
                                    onEdit = { 
                                        val intent = Intent(itemContext, AppRunnerActivity::class.java).apply {
                                            putExtra("APP_CODE", currentApp.code)
                                            putExtra("APP_ID", currentApp.id)
                                            putExtra("EDIT_MODE", true)
                                            addFlags(Intent.FLAG_ACTIVITY_NEW_DOCUMENT)
                                        }
                                        itemContext.startActivity(intent)
                                    },
                                    onDelete = { viewModel.deleteApp(currentApp) },
                                    onRename = { newName -> viewModel.renameApp(currentApp, newName) },
                                    onUpdateIcon = { path -> viewModel.updateAppIcon(currentApp, path) }
                                )
                            }
                        }
                    }
                }
            }
        }
    }
    


    if (showCreateDialog) {
        ChatDialog(
            title = "Criar Novo App",
            onDismiss = { showCreateDialog = false },
            onSend = { prompt ->
                viewModel.createApp(prompt) { showCreateDialog = false }
            },
            isGenerating = isGenerating
        )
    }
    
    if (editingApp != null) {
         ChatDialog(
            title = "Editar ${editingApp!!.name}",
            onDismiss = { editingApp = null },
            onSend = { prompt ->
                 viewModel.updateApp(editingApp!!, prompt) { editingApp = null }
            },
            isGenerating = isGenerating
        )       
    }
}

@Composable
fun OnboardingStep(number: String, title: String, description: String) {
    Row(
        modifier = Modifier.padding(vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Surface(
            modifier = Modifier.size(28.dp),
            shape = CircleShape,
            color = MaterialTheme.colorScheme.primary
        ) {
            Box(contentAlignment = Alignment.Center) {
                Text(
                    number,
                    color = MaterialTheme.colorScheme.onPrimary,
                    fontWeight = FontWeight.Bold,
                    fontSize = 14.sp
                )
            }
        }
        Spacer(modifier = Modifier.width(12.dp))
        Column {
            Text(
                title, 
                fontWeight = FontWeight.SemiBold,
                color = MaterialTheme.colorScheme.onSurface
            )
            Text(
                description,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f)
            )
        }
    }
}

@Composable
fun AppItem(
    app: GeneratedApp, 
    onRun: () -> Unit, 
    onEdit: () -> Unit, 
    onDelete: () -> Unit, 
    onRename: (String) -> Unit,
    onUpdateIcon: (String) -> Unit
) {
    val context = LocalContext.current
    var showShortcutDialog by remember(app.id) { mutableStateOf(false) }
    var showRenameDialog by remember(app.id) { mutableStateOf(false) }
    var showIconPickerDialog by remember(app.id) { mutableStateOf(false) }
    var showDeleteConfirm by remember { mutableStateOf(false) }
    
    // Create temp file for cropped image
    val iconDir = File(context.filesDir, "icons")
    if (!iconDir.exists()) iconDir.mkdirs()
    val iconFile = File(iconDir, "app_${app.id}.png")
    val iconUri = androidx.core.content.FileProvider.getUriForFile(
        context,
        "${context.packageName}.fileprovider",
        iconFile
    )
    
    // Crop launcher and Image picker
    val cropLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.StartActivityForResult()
    ) { result ->
        if (result.resultCode == android.app.Activity.RESULT_OK) {
            onUpdateIcon(iconFile.absolutePath)
        }
    }
    
    fun launchCrop(sourceUri: Uri) {
        try {
            val cropIntent = android.content.Intent("com.android.camera.action.CROP").apply {
                setDataAndType(sourceUri, "image/*")
                putExtra("crop", "true")
                putExtra("aspectX", 1)
                putExtra("aspectY", 1)
                putExtra("outputX", 192)
                putExtra("outputY", 192)
                putExtra("scale", true)
                putExtra(android.provider.MediaStore.EXTRA_OUTPUT, iconUri)
                putExtra("return-data", false)
                addFlags(android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION)
                addFlags(android.content.Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
            }
            cropLauncher.launch(cropIntent)
        } catch (e: Exception) {
            try {
                context.contentResolver.openInputStream(sourceUri)?.use { input ->
                    FileOutputStream(iconFile).use { output -> input.copyTo(output) }
                }
                onUpdateIcon(iconFile.absolutePath)
            } catch (ex: Exception) { ex.printStackTrace() }
        }
    }
    
    val imagePicker = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.GetContent()
    ) { uri: Uri? -> uri?.let { launchCrop(it) } }
    
    val iconBitmap = remember(app.iconPath, app.lastUpdated) {
        app.iconPath?.let { path ->
            try {
                val file = File(path)
                if (file.exists()) BitmapFactory.decodeFile(path) else null
            } catch (e: Exception) { null }
        }
    }
    
    Card(
        modifier = Modifier
            .fillMaxWidth(),
        shape = RoundedCornerShape(16.dp),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surface
        ),
        elevation = CardDefaults.cardElevation(defaultElevation = 4.dp)
    ) {
        Row(
            modifier = Modifier
                .padding(16.dp)
                .fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Row(
                modifier = Modifier.weight(1f),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Surface(
                    modifier = Modifier
                        .size(48.dp)
                        .clickable { showIconPickerDialog = true },
                    shape = RoundedCornerShape(12.dp),
                    color = MaterialTheme.colorScheme.primaryContainer
                ) {
                    Box(contentAlignment = Alignment.Center) {
                        if (iconBitmap != null) {
                            Image(
                                bitmap = iconBitmap.asImageBitmap(),
                                contentDescription = "App Icon",
                                modifier = Modifier.fillMaxSize(),
                                contentScale = ContentScale.Crop
                            )
                        } else {
                            Text(
                                text = app.name.take(2).uppercase(),
                                style = MaterialTheme.typography.titleMedium,
                                color = MaterialTheme.colorScheme.onPrimaryContainer
                            )
                        }
                    }
                }
                
                Spacer(modifier = Modifier.width(12.dp))
                
                Column(modifier = Modifier.clickable { showRenameDialog = true }) {
                    Text(
                        text = app.name,
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.SemiBold,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis
                    )
                    Text(
                        text = "v${app.currentVersion} • ${java.text.SimpleDateFormat("dd/MM HH:mm", java.util.Locale.getDefault()).format(java.util.Date(app.lastUpdated))}",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }
            
            Row {
                IconButton(onClick = onRun) {
                    Icon(
                        Icons.Default.PlayArrow,
                        contentDescription = "Executar",
                        tint = MaterialTheme.colorScheme.primary
                    )
                }
                IconButton(onClick = { showShortcutDialog = true }) {
                    Icon(
                        Icons.Default.Home,
                        contentDescription = "Criar Atalho",
                        tint = MaterialTheme.colorScheme.secondary
                    )
                }
                IconButton(onClick = onEdit) {
                    Icon(
                        Icons.Default.Edit,
                        contentDescription = "Editar",
                        tint = MaterialTheme.colorScheme.primary
                    )
                }
                IconButton(onClick = { showDeleteConfirm = true }) {
                    Icon(
                        Icons.Default.Delete,
                        contentDescription = "Deletar",
                        tint = MaterialTheme.colorScheme.error
                    )
                }
            }
        }
    }
    
    // Dialogs...
    if (showIconPickerDialog) {
        AlertDialog(
            onDismissRequest = { showIconPickerDialog = false },
            title = { Text("Escolher Ícone") },
            text = {
                Column {
                    TextButton(
                        onClick = {
                            showIconPickerDialog = false
                            imagePicker.launch("image/*")
                        },
                        modifier = Modifier.fillMaxWidth()
                    ) { Text("📁 Escolher da Galeria") }
                    TextButton(
                        onClick = {
                            showIconPickerDialog = false
                            val searchQuery = "app icon ${app.name} png transparent"
                            val intent = android.content.Intent(
                                android.content.Intent.ACTION_VIEW,
                                Uri.parse("https://www.google.com/search?tbm=isch&q=${Uri.encode(searchQuery)}")
                            )
                            context.startActivity(intent)
                        },
                        modifier = Modifier.fillMaxWidth()
                    ) { Text("🔍 Buscar na Web") }
                }
            },
            confirmButton = {},
            dismissButton = {
                TextButton(onClick = { showIconPickerDialog = false }) { Text("Cancelar") }
            }
        )
    }
    
    if (showShortcutDialog) {
        ShortcutDialog(
            defaultName = app.name,
            onDismiss = { showShortcutDialog = false },
            onConfirm = { shortcutName ->
                ShortcutHelper.createShortcut(context, app, shortcutName)
                onRename(shortcutName)
                showShortcutDialog = false
            }
        )
    }
    
    if (showRenameDialog) {
        RenameDialog(
            currentName = app.name,
            onDismiss = { showRenameDialog = false },
            onConfirm = { newName ->
                onRename(newName)
                showRenameDialog = false
            }
        )
    }
    
    if (showDeleteConfirm) {
        AlertDialog(
            onDismissRequest = { showDeleteConfirm = false },
            title = { Text("Deletar app?") },
            text = { Text("Tem certeza que deseja deletar '${app.name}'? Ação irreversível.") },
            confirmButton = {
                TextButton(onClick = { onDelete(); showDeleteConfirm = false }) {
                    Text("Deletar", color = MaterialTheme.colorScheme.error)
                }
            },
            dismissButton = {
                TextButton(onClick = { showDeleteConfirm = false }) { Text("Cancelar") }
            }
        )
    }
}

@Composable
fun RenameDialog(currentName: String, onDismiss: () -> Unit, onConfirm: (String) -> Unit) {
    var name by remember { mutableStateOf(currentName) }
    
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Renomear App") },
        text = {
            OutlinedTextField(
                value = name,
                onValueChange = { name = it },
                label = { Text("Nome do App") },
                singleLine = true
            )
        },
        confirmButton = {
            Button(onClick = { if (name.isNotBlank()) onConfirm(name) }) { Text("Salvar") }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text("Cancelar") }
        }
    )
}

@Composable
fun ShortcutDialog(defaultName: String, onDismiss: () -> Unit, onConfirm: (String) -> Unit) {
    var shortcutName by remember { mutableStateOf(defaultName) }
    
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Criar Atalho") },
        text = {
            OutlinedTextField(
                value = shortcutName,
                onValueChange = { shortcutName = it },
                label = { Text("Nome do Atalho") },
                singleLine = true
            )
        },
        confirmButton = {
            Button(onClick = { if (shortcutName.isNotBlank()) onConfirm(shortcutName) }) { Text("Criar") }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text("Cancelar") }
        }
    )
}

@Composable
fun ChatDialog(title: String, onDismiss: () -> Unit, onSend: (String) -> Unit, isGenerating: Boolean) {
    var text by remember { mutableStateOf("") }
    var isListening by remember { mutableStateOf(false) }
    
    val speechLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.StartActivityForResult()
    ) { result ->
        isListening = false
        if (result.resultCode == android.app.Activity.RESULT_OK) {
            val spokenText = result.data
                ?.getStringArrayListExtra(android.speech.RecognizerIntent.EXTRA_RESULTS)
                ?.firstOrNull() ?: ""
            if (spokenText.isNotEmpty()) {
                text = if (text.isEmpty()) spokenText else "$text $spokenText"
            }
        }
    }
    
    fun startSpeechRecognition() {
        val intent = android.content.Intent(android.speech.RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(android.speech.RecognizerIntent.EXTRA_LANGUAGE_MODEL, 
                     android.speech.RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(android.speech.RecognizerIntent.EXTRA_LANGUAGE, java.util.Locale.getDefault())
            putExtra(android.speech.RecognizerIntent.EXTRA_PROMPT, "Descreva o que o app deve fazer...")
        }
        try {
            isListening = true
            speechLauncher.launch(intent)
        } catch (e: Exception) {
            isListening = false
            e.printStackTrace()
        }
    }
    
    if (isGenerating) {
        AlertDialog(
            onDismissRequest = {},
            title = { Text(title) },
            text = { 
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    CircularProgressIndicator()
                    Text("Criando Mágica...")
                }
            },
            confirmButton = {}
        )
    } else {
        AlertDialog(
            onDismissRequest = onDismiss,
            title = { Text(title) },
            text = {
                Column {
                    OutlinedTextField(
                        value = text,
                        onValueChange = { text = it },
                        label = { Text("Descreva os requisitos") },
                        modifier = Modifier.fillMaxWidth().height(120.dp),
                        trailingIcon = {
                            IconButton(onClick = { startSpeechRecognition() }) {
                                Text(
                                    text = if (isListening) "⏳" else "🎤",
                                    style = MaterialTheme.typography.titleLarge
                                )
                            }
                        }
                    )
                    Spacer(modifier = Modifier.height(8.dp))
                    Text(
                        "💡 Toque no 🎤 para falar ao invés de digitar",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            },
            confirmButton = {
                Button(onClick = { if (text.isNotBlank()) onSend(text) }) { Text("Enviar") }
            },
            dismissButton = {
                TextButton(onClick = onDismiss) { Text("Cancelar") }
            }
        )
    }
}

@Composable
fun AppacadabraTheme(content: @Composable () -> Unit) {
    val darkColorScheme = darkColorScheme(
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
    MaterialTheme(colorScheme = darkColorScheme, content = content)
}

@Composable
fun VersionHistoryDialog(
    app: GeneratedApp,
    versions: List<AppVersion>,
    onDismiss: () -> Unit,
    onSelectVersion: (AppVersion) -> Unit
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Histórico - ${app.name}") },
        text = {
            if (versions.isEmpty()) {
                Text("Sem histórico disponível")
            } else {
                Column {
                    Text("Atual: v${app.currentVersion}", style = MaterialTheme.typography.bodySmall)
                    Spacer(modifier = Modifier.height(8.dp))
                    LazyColumn(modifier = Modifier.height(200.dp)) {
                        items(versions) { version ->
                            val isCurrentVersion = version.version == app.currentVersion
                            Card(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(vertical = 4.dp)
                                    .clickable(enabled = !isCurrentVersion) { onSelectVersion(version) },
                                colors = CardDefaults.cardColors(
                                    containerColor = if (isCurrentVersion) 
                                        MaterialTheme.colorScheme.primaryContainer 
                                    else 
                                        MaterialTheme.colorScheme.surface
                                )
                            ) {
                                Row(
                                    modifier = Modifier.padding(12.dp),
                                    horizontalArrangement = Arrangement.SpaceBetween,
                                    verticalAlignment = Alignment.CenterVertically
                                ) {
                                    Column {
                                        Text(
                                            "Versão ${version.version}",
                                            style = MaterialTheme.typography.bodyMedium
                                        )
                                        Text(
                                            java.text.SimpleDateFormat("dd/MM/yyyy HH:mm", java.util.Locale.getDefault())
                                                .format(java.util.Date(version.createdAt)),
                                            style = MaterialTheme.typography.bodySmall
                                        )
                                    }
                                    if (isCurrentVersion) {
                                        Text("Atual", style = MaterialTheme.typography.labelSmall)
                                    }
                                }
                            }
                        }
                    }
                }
            }
        },
        confirmButton = {
            TextButton(onClick = onDismiss) { Text("Fechar") }
        }
    )
}
