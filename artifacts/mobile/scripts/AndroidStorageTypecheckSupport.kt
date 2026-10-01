package com.diwan.downloader

/**
 * Compile-only stand-ins for Diwan types whose real definitions require Expo/engine libraries.
 * Android Context, AtomicFile, Os, FileDescriptor, JSONObject and errno types come from the
 * actual platform android.jar. This file is outside module sources and never ships in the APK.
 */
internal class DownloadError(val errorCode: String, message: String, cause: Throwable? = null) :
  Exception(message, cause)

internal object DownloadEngine {
  const val MAX_BYTES = 120L * 1024 * 1024
}