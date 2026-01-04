package com.example.appacadabra.utils

object CodeExtractor {
    fun extractHtml(response: String): String {
        val regex = "```html\\s*([\\s\\S]*?)\\s*```".toRegex(RegexOption.IGNORE_CASE)
        val match = regex.find(response)
        
        return if (match != null) {
            match.groupValues[1].trim()
        } else {
            if (response.contains("<html", ignoreCase = true)) {
                 response.substring(response.indexOf("<html", ignoreCase = true))
            } else {
                response
            }
        }
    }
}
