package com.diwan.downloader

import android.content.Context
import android.util.AtomicFile
import java.io.File
import java.io.FileInputStream
import java.io.FileNotFoundException
import java.io.FileOutputStream
import java.io.InputStream
import java.security.MessageDigest

/** Installs the authenticated zipapp shipped with this APK; no runtime updater is used. */
internal object PinnedEngine {
  const val ASSET_PATH = "diwan-engine/yt-dlp"
  const val VERSION = "2026.08.19"
  const val EXPECTED_SIZE = 3_072_469L
  const val MAX_SIZE = 8L * 1024 * 1024
  const val SHA256 = "1fa6733c37ea6fb51c99ad8fe785e7b7e5f3246c9b980230329d4fb72ed8d4d6"

  private const val DIRECTORY = "youtubedl-android/yt-dlp"
  private const val ENGINE_FILE = "yt-dlp"
  private const val STAGING_FILE = ".yt-dlp.pinned-staging"
  private const val BUFFER_SIZE = 32 * 1024

  private fun engineFile(context: Context) = File(context.noBackupFilesDir, "$DIRECTORY/$ENGINE_FILE")

  /** AtomicFile.openRead restores a .bak before YoutubeDL.init can inspect the path. */
  fun recoverBeforeInit(context: Context, check: () -> Unit) {
    check()
    val engine = engineFile(context)
    val backup = File(engine.parentFile, "${engine.name}.bak")
    if (!engine.exists() && !backup.exists()) return
    try {
      AtomicFile(engine).openRead().use { /* Opening performs AtomicFile's backup recovery. */ }
      check()
    } catch (e: DownloadError) {
      throw e
    } catch (_: FileNotFoundException) {
      if (backup.exists()) throw installFailure()
    } catch (_: Exception) {
      throw installFailure()
    }
  }

  fun install(context: Context, check: () -> Unit) =
    install(context, check) { context.assets.open(ASSET_PATH) }

  /** Internal source seam lets instrumentation exercise failures without weakening production pins. */
  internal fun install(context: Context, check: () -> Unit, openBundled: () -> InputStream) {
    val engine = engineFile(context)
    val directory = engine.parentFile ?: throw installFailure()
    val staging = File(directory, STAGING_FILE)
    try {
      check()
      if ((!directory.isDirectory && !directory.mkdirs()) || !directory.isDirectory) throw installFailure()
      if (staging.exists() && !staging.delete()) throw installFailure()
      copyBundled(openBundled, staging, check)
      if (!isPinnedPackage(staging, check)) {
        throw DownloadError("E_ENGINE_PACKAGE_INVALID", "Bundled yt-dlp package failed integrity validation")
      }

      val atomic = AtomicFile(engine)
      val installedIsPinned = try {
        atomic.openRead().use { /* Recover any backup before validating the installed engine. */ }
        isPinnedPackage(engine, check)
      } catch (_: FileNotFoundException) {
        false
      }
      if (installedIsPinned) return

      var output: FileOutputStream? = null
      try {
        output = atomic.startWrite()
        copyFile(staging, output, check)
        check()
        atomic.finishWrite(output)
        output = null
      } catch (e: DownloadError) {
        atomic.failWrite(output)
        output = null
        if (e.errorCode == "E_STORAGE") throw installFailure()
        throw e
      } catch (_: Exception) {
        atomic.failWrite(output)
        output = null
        throw installFailure()
      }
      try {
        DownloadStore.syncDirectory(directory)
      } catch (_: Exception) {
        throw installFailure()
      }

      check()
      val confirmed = try {
        atomic.openRead().use { /* Recover before confirming the atomically published engine. */ }
        isPinnedPackage(engine, check)
      } catch (_: FileNotFoundException) {
        false
      } catch (e: DownloadError) {
        throw e
      } catch (_: Exception) {
        false
      }
      if (!confirmed) throw installFailure()
    } catch (e: DownloadError) {
      throw e
    } catch (_: Exception) {
      throw installFailure()
    } finally {
      if (staging.exists() && !staging.delete()) throw installFailure()
    }
  }

  private fun copyBundled(openBundled: () -> InputStream, destination: File, check: () -> Unit) {
    val input = try {
      openBundled()
    } catch (_: Exception) {
      throw DownloadError("E_ENGINE_PACKAGE_INVALID", "Bundled yt-dlp asset is unavailable")
    }
    try {
      input.use { source ->
        FileOutputStream(destination, false).use { output ->
          val buffer = ByteArray(BUFFER_SIZE)
          var total = 0L
          while (true) {
            check()
            val count = source.read(buffer)
            if (count < 0) break
            if (count == 0) continue
            total += count
            if (total > MAX_SIZE || total > EXPECTED_SIZE) {
              throw DownloadError("E_ENGINE_PACKAGE_INVALID", "Bundled yt-dlp asset exceeds its pinned size")
            }
            output.write(buffer, 0, count)
          }
          check()
          output.fd.sync()
          if (total != EXPECTED_SIZE) {
            throw DownloadError("E_ENGINE_PACKAGE_INVALID", "Bundled yt-dlp asset has an unexpected size")
          }
        }
      }
    } catch (e: DownloadError) {
      throw e
    } catch (_: Exception) {
      throw installFailure()
    }
  }

  private fun copyFile(source: File, destination: FileOutputStream, check: () -> Unit) {
    FileInputStream(source).use { input ->
      val buffer = ByteArray(BUFFER_SIZE)
      var total = 0L
      while (true) {
        check()
        val count = input.read(buffer)
        if (count < 0) break
        if (count == 0) continue
        total += count
        if (total > MAX_SIZE) throw DownloadError("E_ENGINE_PACKAGE_INVALID", "Pinned yt-dlp staging file exceeds its size limit")
        destination.write(buffer, 0, count)
      }
      check()
      if (total != EXPECTED_SIZE) throw DownloadError("E_ENGINE_PACKAGE_INVALID", "Pinned yt-dlp staging file has an unexpected size")
      destination.fd.sync()
    }
  }

  private fun isPinnedPackage(file: File, check: () -> Unit): Boolean {
    if (!file.isFile || file.length() != EXPECTED_SIZE || file.length() > MAX_SIZE) return false
    if (sha256(file, check) != SHA256) return false
    return try {
      EngineZipValidation.isValid(file, VERSION) { check() }
    } catch (e: DownloadError) {
      throw e
    } catch (_: Exception) {
      false
    }
  }

  private fun sha256(file: File, check: () -> Unit): String {
    val digest = MessageDigest.getInstance("SHA-256")
    FileInputStream(file).use { input ->
      val buffer = ByteArray(BUFFER_SIZE)
      while (true) {
        check()
        val count = input.read(buffer)
        if (count < 0) break
        if (count > 0) digest.update(buffer, 0, count)
      }
    }
    val digits = "0123456789abcdef"
    return buildString(64) {
      digest.digest().forEach { byte ->
        val value = byte.toInt() and 0xff
        append(digits[value ushr 4])
        append(digits[value and 0x0f])
      }
    }
  }

  private fun installFailure() =
    DownloadError("E_ENGINE_INSTALL", "Unable to install the bundled yt-dlp engine")
}