package com.diwan.downloader

import android.content.Context
import android.content.ContextWrapper
import android.system.Os
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.ByteArrayInputStream
import java.io.File
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class PinnedEngineTest {
  private lateinit var root: File
  private lateinit var context: Context

  @Before fun setup() {
    val app = InstrumentationRegistry.getInstrumentation().targetContext
    root = File(app.cacheDir, "pinned-engine-test-${UUID.randomUUID()}").apply { mkdirs() }
    context = object : ContextWrapper(app) {
      override fun getNoBackupFilesDir() = File(root, "no-backup").apply { mkdirs() }
    }
  }

  @After fun teardown() { root.deleteRecursively() }

  private fun engineFile() = File(context.noBackupFilesDir, "youtubedl-android/yt-dlp/yt-dlp")

  private fun bundledBytes(): ByteArray {
    return InstrumentationRegistry.getInstrumentation().targetContext.assets
      .open(PinnedEngine.ASSET_PATH).use { it.readBytes() }
  }

  @Test fun checksumMismatchDoesNotReplaceExistingEngine() {
    val target = engineFile().apply {
      parentFile!!.mkdirs()
      writeText("existing engine must survive")
    }
    val existing = target.readBytes()
    val wrongPinnedSize = ByteArray(PinnedEngine.EXPECTED_SIZE.toInt())
    try {
      PinnedEngine.install(context, {}) { ByteArrayInputStream(wrongPinnedSize) }
      fail("checksum mismatch must be rejected")
    } catch (error: DownloadError) {
      assertEquals("E_ENGINE_PACKAGE_INVALID", error.errorCode)
    }
    assertArrayEquals(existing, target.readBytes())
    assertFalse(File(target.parentFile, ".yt-dlp.pinned-staging").exists())
  }

  @Test fun cancellationDuringCopyKeepsInstalledEngineAndRemovesStagingFile() {
    val target = engineFile().apply {
      parentFile!!.mkdirs()
      writeText("existing engine must survive cancellation")
    }
    val existing = target.readBytes()
    val bundled = bundledBytes()
    var checks = 0
    try {
      PinnedEngine.install(context, {
        checks += 1
        if (checks == 5) throw DownloadError("E_CANCELLED", "cancelled")
      }) { ByteArrayInputStream(bundled) }
      fail("install should stop when cancelled")
    } catch (error: DownloadError) {
      assertEquals("E_CANCELLED", error.errorCode)
    }
    assertArrayEquals(existing, target.readBytes())
    assertFalse(File(target.parentFile, ".yt-dlp.pinned-staging").exists())
  }

  @Test fun replacesOldEngineAndRepeatedInstallIsIdempotent() {
    val bundled = bundledBytes()
    assertEquals(PinnedEngine.EXPECTED_SIZE.toInt(), bundled.size)
    val target = engineFile().apply {
      parentFile!!.mkdirs()
      writeText("obsolete engine")
    }
    PinnedEngine.install(context) {}
    assertArrayEquals(bundled, target.readBytes())
    assertFalse(File(target.parentFile, "${target.name}.bak").exists())

    val before = Os.lstat(target.absolutePath)
    PinnedEngine.install(context) {}
    val after = Os.lstat(target.absolutePath)
    assertEquals(before.st_ino, after.st_ino)
    assertArrayEquals(bundled, target.readBytes())
  }

  @Test fun recoversAtomicBackupBeforeDownloaderInitialization() {
    val bundled = bundledBytes()
    val target = engineFile().apply {
      parentFile!!.mkdirs()
      writeText("interrupted replacement")
    }
    File(target.parentFile, "${target.name}.bak").writeBytes(bundled)

    PinnedEngine.recoverBeforeInit(context) {}
    assertArrayEquals(bundled, target.readBytes())
    assertFalse(File(target.parentFile, "${target.name}.bak").exists())
  }
}