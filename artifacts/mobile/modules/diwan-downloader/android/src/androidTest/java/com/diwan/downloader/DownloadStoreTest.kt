package com.diwan.downloader

import android.content.Context
import android.content.ContextWrapper
import android.system.Os
import android.system.OsConstants
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
  private fun record() = DownloadRecord("recording", "https://www.youtube.com/watch?v=abcdefghijk", storageVersion = 1)
  private fun v2Record(id: String = "recording") =
    DownloadRecord(id, "https://www.youtube.com/watch?v=abcdefghijk")
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

  @Test fun journalWithoutStorageVersionRemainsLegacyFormatOne() {
    val s = DownloadStore(context)
    val r = record()
    staged(s, r)
    s.publish(r)
    val journal = File(context.noBackupFilesDir, "diwan-download-journal/${r.recordingId}.json")
    journal.writeText(org.json.JSONObject(journal.readText()).apply { remove("storageVersion") }.toString())
    val recovered = DownloadStore(context)
    val found = recovered.records[r.recordingId]!!
    assertEquals(1, found.storageVersion)
    assertTrue(recovered.ownsFinal(found))
    assertFalse(recovered.view(found).containsKey("storageVersion"))
    assertFalse(recovered.view(found).containsKey("token"))
  }

  @Test fun v2PublishesByCopyIntoNonceNamespaceAndPreservesForeignFlatFile() {
    val s = DownloadStore(context)
    val r = v2Record()
    staged(s, r)
    val flat = s.flatFile(r.recordingId).apply { writeText("foreign") }
    s.publish(r)
    val stageStat = Os.lstat(File(s.stage(r), "audio.mp3").absolutePath)
    val publishedStat = Os.lstat(s.finalFile(r).absolutePath)
    assertEquals(2, r.storageVersion)
    assertTrue(stageStat.st_ino != publishedStat.st_ino)
    assertEquals("foreign", flat.readText())
    assertTrue(s.ownsFinal(r))
    assertTrue(s.view(r).containsKey("token"))
    assertEquals(2, s.view(r)["storageVersion"])
    assertTrue(s.finalFile(r).absolutePath.contains("/.diwan-v2/${r.recordingId}/${r.token}/audio.mp3"))
  }

  @Test fun v2ReadyFalseRecoveryInterruptsAndCleansOnlyJournalProvenBundle() {
    val s = DownloadStore(context)
    val r = v2Record()
    staged(s, r)
    val source = File(s.stage(r), "audio.mp3")
    TokenPublication.prepare(File(context.filesDir, "recording-audio"), r, source)
    s.save(r, StorageStage.PUBLICATION_JOURNAL)
    r.ownerProofDurable = true
    TokenPublication.copyAndVerify(File(context.filesDir, "recording-audio"), r, source)
    assertFalse(r.publicationReady)
    val recovered = DownloadStore(context)
    val found = recovered.records[r.recordingId]!!
    assertEquals("interrupted", found.state)
    assertFalse(found.publicationReady)
    assertFalse(TokenPublication.markerExists(File(context.filesDir, "recording-audio"), found))
  }

  @Test fun v2ReadyPublicationIntentRecoversCompletionBeforeCompletionJournal() {
    val s = DownloadStore(context)
    val r = v2Record()
    staged(s, r)
    s.publish(r)
    r.state = "running"
    r.publicationReady = true
    s.save(r, StorageStage.PUBLICATION_JOURNAL)
    val recovered = DownloadStore(context)
    val found = recovered.records[r.recordingId]!!
    assertEquals("completed", found.state)
    assertTrue(recovered.ownsFinal(found))
    assertTrue(recovered.finalFile(found).exists())
  }

  @Test fun startPreflightSeesFlatAndSavedV2IdCollisionsWithoutChangingThem() {
    val s = DownloadStore(context)
    val flat = s.flatFile("flat-id").apply { writeText("legacy owner") }
    assertTrue(s.hasStartCollision("flat-id"))
    assertEquals("legacy owner", flat.readText())
    val idDirectory = TokenPublication.idDirectory(File(context.filesDir, "recording-audio"), "saved-id")
    assertTrue(idDirectory.mkdirs())
    File(idDirectory, "foreign").writeText("keep")
    assertTrue(s.hasStartCollision("saved-id"))
    assertEquals("keep", File(idDirectory, "foreign").readText())
  }

  @Test fun unknownMarkerAndExtraEntryRefusePartialCleanup() {
    val s = DownloadStore(context)
    val r = v2Record()
    staged(s, r)
    val target = File(context.filesDir, "recording-audio")
    val source = File(s.stage(r), "audio.mp3")
    TokenPublication.prepare(target, r, source)
    s.save(r, StorageStage.PUBLICATION_JOURNAL)
    r.ownerProofDurable = true
    TokenPublication.copyAndVerify(target, r, source)
    val goodMarker = TokenPublication.marker(target, r).readBytes()
    File(TokenPublication.marker(target, r).absolutePath).appendText(" ")
    try { TokenPublication.cleanupPartial(target, r); fail("tampered marker must be preserved") }
    catch (_: DownloadError) { assertTrue(TokenPublication.marker(target, r).exists()) }

    TokenPublication.marker(target, r).writeBytes(goodMarker)
    File(TokenPublication.directory(target, r), "foreign").writeText("keep")
    try { TokenPublication.cleanupPartial(target, r); fail("extra entry must be preserved") }
    catch (_: DownloadError) {
      assertEquals("keep", File(TokenPublication.directory(target, r), "foreign").readText())
    }
  }

  @Test fun malformedJournalProofRefusesCleanupAndPreservesBundle() {
    val s = DownloadStore(context)
    val r = v2Record()
    staged(s, r)
    val target = File(context.filesDir, "recording-audio")
    TokenPublication.prepare(target, r, File(s.stage(r), "audio.mp3"))
    s.save(r, StorageStage.PUBLICATION_JOURNAL)
    r.ownerProofDurable = true
    val journal = File(context.noBackupFilesDir, "diwan-download-journal/${r.recordingId}.json")
    val json = org.json.JSONObject(journal.readText()).put("expectedSha256", "not-a-sha256")
    journal.writeText(json.toString())
    val recovered = DownloadStore(context)
    val found = recovered.records[r.recordingId]!!
    assertEquals("failed", found.state)
    assertEquals("E_PROVENANCE", found.errorCode)
    assertTrue(TokenPublication.marker(target, found).exists())
    assertTrue(TokenPublication.audio(target, found).exists())
  }

  @Test fun unknownStorageVersionIsNotReinterpretedAsLegacy() {
    val s = DownloadStore(context)
    val r = v2Record()
    staged(s, r)
    val target = File(context.filesDir, "recording-audio")
    val source = File(s.stage(r), "audio.mp3")
    TokenPublication.prepare(target, r, source)
    s.save(r, StorageStage.PUBLICATION_JOURNAL)
    r.ownerProofDurable = true
    TokenPublication.copyAndVerify(target, r, source)
    val journal = File(context.noBackupFilesDir, "diwan-download-journal/${r.recordingId}.json")
    journal.writeText(org.json.JSONObject(journal.readText()).put("storageVersion", 99).toString())
    val recovered = DownloadStore(context)
    val found = recovered.records[r.recordingId]!!
    assertEquals(99, found.storageVersion)
    assertEquals("failed", found.state)
    assertTrue(TokenPublication.audio(target, found).exists())
    assertTrue(TokenPublication.marker(target, found).exists())
  }

  @Test fun symlinkAndReplacedInodeRefusePartialCleanup() {
    val s = DownloadStore(context)
    val r = v2Record()
    staged(s, r)
    val target = File(context.filesDir, "recording-audio")
    val source = File(s.stage(r), "audio.mp3")
    TokenPublication.prepare(target, r, source)
    s.save(r, StorageStage.PUBLICATION_JOURNAL)
    r.ownerProofDurable = true
    TokenPublication.copyAndVerify(target, r, source)
    val audio = TokenPublication.audio(target, r)
    val replacement = File(root, "foreign-audio").apply { writeText("foreign") }
    assertTrue(audio.delete())
    Os.symlink(replacement.absolutePath, audio.absolutePath)
    try { TokenPublication.cleanupPartial(target, r); fail("symlink must be preserved") }
    catch (_: DownloadError) {
      assertTrue(OsConstants.S_ISLNK(Os.lstat(audio.absolutePath).st_mode))
      assertEquals("foreign", replacement.readText())
    }

    assertTrue(audio.delete())
    audio.writeBytes(source.readBytes())
    try { TokenPublication.cleanupPartial(target, r); fail("replacement inode must be preserved") }
    catch (_: DownloadError) {
      assertTrue(audio.exists())
      assertEquals(source.readBytes().toList(), audio.readBytes().toList())
    }
  }

  @Test fun readyBundleWithTruncatedOrChangedHashFailsRecoveryAndIsPreserved() {
    val s = DownloadStore(context)
    val r = v2Record()
    staged(s, r)
    s.publish(r)
    s.finalFile(r).writeBytes(byteArrayOf(9, 8))
    val recovered = DownloadStore(context)
    val found = recovered.records[r.recordingId]!!
    assertEquals("failed", found.state)
    assertEquals("E_PROVENANCE", found.errorCode)
    assertTrue(recovered.finalFile(found).exists())
  }

  @Test fun cancellationPartialCleanupAndOwnedDiscardAreConservative() {
    val s = DownloadStore(context)
    val partial = v2Record("partial")
    staged(s, partial)
    val target = File(context.filesDir, "recording-audio")
    val source = File(s.stage(partial), "audio.mp3")
    TokenPublication.prepare(target, partial, source)
    s.save(partial, StorageStage.PUBLICATION_JOURNAL)
    partial.ownerProofDurable = true
    File(TokenPublication.audio(target, partial).absolutePath).writeBytes(byteArrayOf(1))
    partial.state = "cancelled"
    s.save(partial)
    s.cleanup(partial)
    assertFalse(TokenPublication.markerExists(target, partial))

    val owned = v2Record("owned")
    staged(s, owned)
    s.publish(owned)
    s.remove(owned, true)
    assertFalse(TokenPublication.markerExists(target, owned))
    assertFalse(s.records.containsKey(owned.recordingId))
  }

  @Test fun v2AcknowledgementTombstoneKeepsAudioAndProofAcrossRestart() {
    val s = DownloadStore(context)
    val r = v2Record()
    staged(s, r)
    s.publish(r)
    val audio = s.finalFile(r)
    val marker = TokenPublication.marker(File(context.filesDir, "recording-audio"), r)
    s.remove(r, false)
    assertTrue(audio.exists())
    assertTrue(marker.exists())
    val recovered = DownloadStore(context)
    assertNull(recovered.records[r.recordingId])
    assertTrue(audio.exists())
    assertTrue(marker.exists())
  }

  @Test fun failedReadyJournalSaveCannotRescueInMemoryPublication() {
    val s = object : DownloadStore(context) {
      override fun save(r: DownloadRecord, stage: StorageStage) {
        if (stage == StorageStage.PUBLICATION_JOURNAL && r.publicationReady) {
          throw DownloadError("E_TEST", "injected publication-intent journal failure")
        }
        super.save(r, stage)
      }
    }
    val r = v2Record()
    staged(s, r)
    try { s.publish(r); fail("expected injected journal failure") }
    catch (_: DownloadError) {
      assertFalse(r.publicationReady)
      assertFalse(r.publicationDurable)
      assertFalse(s.ownsFinal(r))
    }
  }
}