package com.example.appacadabra.utils

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import com.google.firebase.Firebase
import com.google.firebase.ai.ai
import com.google.firebase.ai.type.GenerativeBackend
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.io.FileOutputStream

object IconGenerator {
    
    private val imageModel by lazy {
        Firebase.ai(backend = GenerativeBackend.googleAI())
            .imagenModel("imagen-3.0-generate-002")
    }
    
    suspend fun generateIcon(context: Context, appId: Long, prompt: String): Result<String> {
        return withContext(Dispatchers.IO) {
            try {
                val imagePrompt = "App icon, flat design, vibrant colors, simple, no text: $prompt"
                val response = imageModel.generateImages(imagePrompt)
                
                val image = response.images.firstOrNull()
                if (image != null) {
                    // Save bitmap to internal storage
                    val iconDir = File(context.filesDir, "icons")
                    if (!iconDir.exists()) {
                        iconDir.mkdirs()
                    }
                    
                    val iconFile = File(iconDir, "app_${appId}.png")
                    FileOutputStream(iconFile).use { out ->
                        image.asBitmap().compress(Bitmap.CompressFormat.PNG, 100, out)
                    }
                    
                    Result.success(iconFile.absolutePath)
                } else {
                    Result.failure(Exception("No image generated"))
                }
            } catch (e: Exception) {
                e.printStackTrace()
                Result.failure(e)
            }
        }
    }
    
    fun getIconBitmap(iconPath: String?): Bitmap? {
        if (iconPath == null) return null
        val file = File(iconPath)
        return if (file.exists()) {
            BitmapFactory.decodeFile(iconPath)
        } else {
            null
        }
    }
    
    fun deleteIcon(iconPath: String?) {
        if (iconPath != null) {
            val file = File(iconPath)
            if (file.exists()) {
                file.delete()
            }
        }
    }
}
