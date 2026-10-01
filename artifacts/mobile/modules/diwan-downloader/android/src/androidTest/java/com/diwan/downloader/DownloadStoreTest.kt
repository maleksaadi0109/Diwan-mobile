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
import java.io.File
import java.util.UUID

/** Filesystem/provenance tests, not network/codec/device-background execution tests. */
@RunWith(AndroidJUnit4::class)
class DownloadStoreTest {
  private lateinit var root: File
  private lateinit var context: Context
  @Before fun setup() {
    val app = InstrumentationRegistry.getInstrumentation().targetContext
    root = File(app.cacheDir, "download-store-test-${UUID.randomUUID()}").apply { mkdirs() }
    context = object : ContextWrapper(app) {
      override fun getFilesDir() = File(root, "files").apply { mkdirs() }
      override fun getCacheDir() = File(root, "cache").apply { mkdirs() }
      override fun getNoBackupFilesDir() = File(root, "no-backup").apply { mkdirs() }
    }
  }
  @After fun teardown() { root.deleteRecursively() }
  private fun record() = DownloadRecord("recording", "https://www.youtube.com/watch?v=abcdefghijk")
  private fun staged(s: DownloadStore, r: DownloadRecord) {
    s.save(r)
    s.stage(r).mkdirs()
    File(s.stage(r), "audio.mp3").writeBytes(byteArrayOf(1, 2, 3, 4))
    r.state = "running"
    r.durationMs = 1000
  }

  @Test fun directorySyncUsesPublicAndroidApiAndRejectsRegularFiles() {
    DownloadStore.syncDirectory(root)
    val regularFile = File(root, "not-a-directory").apply { writeText("keep") }
    try {
      DownloadStore.syncDirectory(regularFile)
      fail("must reject regular file")
    } catch (error: DownloadError) {
      assertEquals("E_STORAGE_STAGE_ERRNO:JOURNAL_SYNC:ENOTDIR", error.errorCode)
    }
    assertEquals("keep", regularFile.readText())
  }

  @Test fun activeRecoveryInterruptsAndCleans() {
    val s = DownloadStore(context)
    val r = record()
    staged(s, r)
    s.save(r)
    val recovered = DownloadStore(context)
    assertEquals("interrupted", recovered.records[r.recordingId]!!.state)
    assertFalse(s.stage(r).exists())
  }

  @Test fun publicationCrashWindowRecoversByInode() {
    val s = DownloadStore(context)
    val r = record()
    staged(s, r)
    s.witness(r).writeBytes(byteArrayOf(1, 2, 3, 4))
    val stat = Os.lstat(s.witness(r).absolutePath)
    r.device = stat.st_dev
    r.inode = stat.st_ino
    s.save(r) // Simulate crash immediately after link but before completed journal.
    Os.link(s.witness(r).absolutePath, s.finalFile(r).absolutePath)
    val recovered = DownloadStore(context)
    assertEquals("completed", recovered.records[r.recordingId]!!.state)
    assertTrue(recovered.ownsFinal(recovered.records[r.recordingId]!!))
  }

  @Test fun publicationNeverReplacesAndDiscardPreservesPreexisting() {
    val s = DownloadStore(context)
    val r = record()
    staged(s, r)
    s.finalFile(r).writeText("preexisting")
    try { s.publish(r); fail("must reject existing final") }
    catch (error: DownloadError) {
      assertEquals("E_STORAGE_STAGE_ERRNO:PUBLICATION_LINK:EEXIST", error.errorCode)
    }
    r.state = "failed"
    s.save(r)
    s.remove(r, true)
    assertEquals("preexisting", s.finalFile(r).readText())
  }

  @Test fun acknowledgeThenDiscardCannotDeleteFinal() {
    val s = DownloadStore(context)
    val r = record()
    staged(s, r)
    s.publish(r)
    s.remove(r, false)
    val recovered = DownloadStore(context)
    assertNull(recovered.records[r.recordingId])
    assertTrue(s.finalFile(r).exists())
    assertFalse(s.witness(r).exists())
  }

  @Test fun discardOwnedCompletionDeletesOnlyOwnedFinal() {
    val s = DownloadStore(context)
    val r = record()
    staged(s, r)
    s.publish(r)
    s.remove(r, true)
    assertFalse(s.finalFile(r).exists())
    assertTrue(s.records.isEmpty())
  }

  @Test fun replacedFinalFailsProvenanceAndSurvivesRecovery() {
    val s = DownloadStore(context)
    val r = record()
    staged(s, r)
    s.publish(r)
    assertTrue(s.finalFile(r).delete())
    s.finalFile(r).writeText("unrelated")
    val recovered = DownloadStore(context)
    assertEquals("failed", recovered.records[r.recordingId]!!.state)
    recovered.remove(recovered.records[r.recordingId]!!, true)
    assertEquals("unrelated", s.finalFile(r).readText())
  }
}