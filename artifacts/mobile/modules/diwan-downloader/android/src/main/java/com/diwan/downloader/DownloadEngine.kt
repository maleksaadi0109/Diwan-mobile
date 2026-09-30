package com.diwan.downloader

import android.content.Context
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Build
import com.yausername.ffmpeg.FFmpeg
import com.yausername.youtubedl_android.YoutubeDL
import com.yausername.youtubedl_android.YoutubeDLRequest
import expo.modules.kotlin.exception.CodedException
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean
import java.util.zip.ZipFile

internal class DownloadError(val errorCode: String, message: String, cause: Throwable? = null) :
  CodedException(errorCode, message, cause)

internal class Transfer(val record: DownloadRecord) {
  val cancelled = AtomicBoolean(false)
  @Volatile var reason = "E_CANCELLED"
  val processId = "diwan-${record.token}"
  fun check() {
    if (cancelled.get()) throw DownloadError(reason, "Audio download cancelled or exceeded its limit")
  }
}

internal object DownloadEngine {
  const val MAX_BYTES = 120L * 1024 * 1024
  const val WALL_MS = 8L * 60 * 1000

  fun canonicalUrl(input: String): String {
    val uri = try { Uri.parse(input) } catch (_: Exception) { null }
      ?: throw DownloadError("E_INVALID_URL", "Invalid YouTube video URL")
    if (uri.scheme != "https" || uri.encodedUserInfo != null || uri.port != -1 ||
      uri.fragment != null || uri.host !in setOf("youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be", "www.youtu.be")
    ) throw DownloadError("E_INVALID_URL", "Only public YouTube video URLs are supported")
    val segments = uri.pathSegments
    val id = when {
      uri.host == "youtu.be" || uri.host == "www.youtu.be" ->
        if (segments.size == 1 && uri.query == null) segments[0] else null
      segments.size == 1 && segments[0] == "watch" && uri.queryParameterNames == setOf("v") ->
        uri.getQueryParameters("v").singleOrNull()
      segments.size == 2 && segments[0] == "shorts" && uri.query == null -> segments[1]
      else -> null
    }
    if (id == null || !Regex("[A-Za-z0-9_-]{11}").matches(id)) {
      throw DownloadError("E_INVALID_URL", "Expected a single YouTube video ID")
    }
    return "https://www.youtube.com/watch?v=$id"
  }

  private fun engineMatchesTag(file: File, tag: String?): Boolean {
    if (!file.isFile || file.length() == 0L || tag.isNullOrBlank()) return false
    return try {
      ZipFile(file).use { zip ->
        val entry = zip.getEntry("yt_dlp/version.py") ?: return false
        if (zip.getEntry("__main__.py") == null || zip.getEntry("yt_dlp_ejs/yt/solver/core.min.js") == null) return false
        val source = zip.getInputStream(entry).bufferedReader().use { it.readText() }
        Regex("""__version__\s*=\s*['"]([^'"]+)""").find(source)?.groupValues?.get(1) == tag
      }
    } catch (_: Exception) { false }
  }

  @Suppress("DEPRECATION")
  private fun ensureCurrentEngine(context: Context, transfer: Transfer) {
    val preferences = context.getSharedPreferences("diwan-downloader-engine", Context.MODE_PRIVATE)
    val info = context.packageManager.getPackageInfo(context.packageName, 0)
    val version = if (Build.VERSION.SDK_INT >= 28) info.longVersionCode else info.versionCode.toLong()
    val key = "0.18.1:${info.versionName}:$version"
    val now = System.currentTimeMillis()
    val last = preferences.getLong("lastSuccessfulCheck", 0L)
    val installed = File(context.noBackupFilesDir, "youtubedl-android/yt-dlp/yt-dlp")
    if (preferences.getString("appLibraryVersion", null) == key &&
      last > 0 && now >= last && now - last < 24L * 60 * 60 * 1000 &&
      engineMatchesTag(installed, YoutubeDL.getInstance().version(context))) return
    transfer.check()
    try {
      YoutubeDL.getInstance().updateYoutubeDL(context, YoutubeDL.UpdateChannel.STABLE)
      if (!engineMatchesTag(installed, YoutubeDL.getInstance().version(context))) {
        throw DownloadError("E_ENGINE_UPDATE", "Updated yt-dlp zipapp is missing, invalid or does not match the stable release")
      }
      transfer.check()
      if (!preferences.edit().putString("appLibraryVersion", key)
          .putLong("lastSuccessfulCheck", System.currentTimeMillis()).commit()) {
        throw DownloadError("E_ENGINE_UPDATE", "Cannot save the successful yt-dlp update check")
      }
    } catch (e: DownloadError) { throw e }
    catch (e: Exception) {
      transfer.check()
      throw DownloadError("E_ENGINE_UPDATE", "Unable to update yt-dlp from the official stable release", e)
    }
  }

  fun run(context: Context, transfer: Transfer, stage: File, progress: (Double) -> Unit): Long {
    transfer.check()
    if (!stage.mkdirs()) throw DownloadError("E_STORAGE", "Unable to create staging directory")
    try {
      YoutubeDL.getInstance().init(context)
      FFmpeg.getInstance().init(context)
    } catch (e: Exception) {
      transfer.check()
      throw DownloadError("E_ENGINE_UPDATE", "Unable to initialize the native audio engine", e)
    }
    transfer.check()
    ensureCurrentEngine(context, transfer)
    transfer.check()
    val request = YoutubeDLRequest(transfer.record.url)
    request.addOption("--ignore-config")
      .addOption("--no-playlist").addOption("--no-simulate").addOption("--no-overwrites")
      .addOption("--no-continue").addOption("--retries", "2").addOption("--fragment-retries", "2")
      .addOption("--socket-timeout", "20").addOption("--max-filesize", "120M")
      .addOption("--match-filter", "duration <= 3600 & !is_live")
      .addOption("-f", "bestaudio/best").addOption("-x").addOption("--audio-format", "mp3")
      .addOption("-o", File(stage, "audio.%(ext)s").absolutePath)
    YoutubeDL.getInstance().execute(request, transfer.processId, false) { value, _, _ ->
      transfer.check()
      if (value in 0f..100f) progress((value / 100.0).coerceIn(0.0, 0.99))
    }
    transfer.check()
    val file = File(stage, "audio.mp3")
    if (!file.isFile || file.length() !in 1..MAX_BYTES) throw DownloadError("E_DOWNLOAD_FAILED", "No valid MP3 was produced")
    val retriever = MediaMetadataRetriever()
    val length = try {
      retriever.setDataSource(file.absolutePath)
      retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: 0
    } finally { retriever.release() }
    if (length !in 1..3_600_000L) throw DownloadError("E_DOWNLOAD_FAILED", "Audio duration exceeds one hour or is invalid")
    return length
  }

  fun kill(transfer: Transfer) {
    try { YoutubeDL.getInstance().destroyProcessById(transfer.processId) } catch (_: Exception) {}
  }
}