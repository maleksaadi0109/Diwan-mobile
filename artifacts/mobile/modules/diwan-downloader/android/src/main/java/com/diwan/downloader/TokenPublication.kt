package com.diwan.downloader

import android.system.ErrnoException
import android.system.Os
import android.system.OsConstants
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.security.MessageDigest
import java.util.UUID

/**
 * Version 2 publication is a private, nonce-scoped copy with durable provenance.
 * The marker is an ownership record, not a same-UID adversary boundary.
 */
internal object TokenPublication {
  private const val ROOT_NAME = ".diwan-v2"
  private const val AUDIO_NAME = "audio.mp3"
  private const val MARKER_NAME = "owner.marker"
  private val markerKeys = setOf(
    "recordingId", "token", "storageVersion", "directoryDevice", "directoryInode",
    "audioDevice", "audioInode", "expectedByteSize", "expectedSha256"
  )

  fun idDirectory(target: File, recordingId: String) =
    File(File(target, ROOT_NAME), recordingId)

  fun directory(target: File, record: DownloadRecord) =
    File(idDirectory(target, record.recordingId), canonicalToken(record))

  fun audio(target: File, record: DownloadRecord) = File(directory(target, record), AUDIO_NAME)
  fun marker(target: File, record: DownloadRecord) = File(directory(target, record), MARKER_NAME)
  fun root(target: File) = File(target, ROOT_NAME)

  fun pathExists(path: File, stage: StorageStage): Boolean = try {
    Os.lstat(path.absolutePath)
    true
  } catch (e: Exception) {
    if (e is ErrnoException && e.errno == OsConstants.ENOENT) false
    else throw StorageFailure.wrap(stage, e)
  }

  /** First pass hashes a bounded regular source before any publication bytes are copied. */
  fun prepare(target: File, record: DownloadRecord, source: File) {
    val (size, digest) = digestFile(source, StorageStage.WITNESS_VERIFY)
    if (size !in 1..DownloadEngine.MAX_BYTES) {
      throw StorageFailure.known(StorageStage.WITNESS_VERIFY, "UNKNOWN")
    }
    val parent = idDirectory(target, record.recordingId)
    val root = parent.parentFile ?: throw StorageFailure.known(StorageStage.WITNESS_CREATE, "UNKNOWN")
    ensureDirectoryNoLink(target, StorageStage.WITNESS_CREATE)
    if (!pathExists(root, StorageStage.WITNESS_CREATE)) {
      if (!root.mkdir()) throw StorageFailure.known(StorageStage.WITNESS_CREATE, "EEXIST")
      DownloadStore.syncDirectory(target, StorageStage.WITNESS_SYNC)
    } else ensureDirectoryNoLink(root, StorageStage.WITNESS_CREATE)

    // Recording-ID directories are exclusive too: an orphan can never be adopted by a retry.
    if (!parent.mkdir()) throw StorageFailure.known(StorageStage.WITNESS_CREATE, "EEXIST")
    DownloadStore.syncDirectory(root, StorageStage.WITNESS_SYNC)
    val bundle = directory(target, record)
    if (!bundle.mkdir()) throw StorageFailure.known(StorageStage.WITNESS_CREATE, "EEXIST")
    DownloadStore.syncDirectory(parent, StorageStage.WITNESS_SYNC)

    try {
      FileOutputStream(audio(target, record).apply {
        if (!createNewFile()) throw StorageFailure.known(StorageStage.WITNESS_CREATE, "EEXIST")
      }).use { it.fd.sync() }
    } catch (e: Exception) {
      if (e is DownloadError) throw e
      throw StorageFailure.wrap(StorageStage.WITNESS_CREATE, e)
    }
    val directoryStat = statDirectory(bundle, StorageStage.WITNESS_STAT)
    val audioStat = statRegular(audio(target, record), StorageStage.WITNESS_STAT)
    val owner = marker(target, record)
    try {
      FileOutputStream(owner.apply {
        if (!createNewFile()) throw StorageFailure.known(StorageStage.WITNESS_CREATE, "EEXIST")
      }).use { output ->
        val content = markerJson(record.recordingId, record.token, directoryStat.st_dev, directoryStat.st_ino,
          audioStat.st_dev, audioStat.st_ino, size, digest).toString().toByteArray(Charsets.UTF_8)
        output.write(content)
        output.fd.sync()
      }
    } catch (e: Exception) {
      if (e is DownloadError) throw e
      throw StorageFailure.wrap(StorageStage.WITNESS_CREATE, e)
    }
    val markerStat = statRegular(owner, StorageStage.WITNESS_STAT)
    record.device = audioStat.st_dev
    record.inode = audioStat.st_ino
    record.directoryDevice = directoryStat.st_dev
    record.directoryInode = directoryStat.st_ino
    record.markerDevice = markerStat.st_dev
    record.markerInode = markerStat.st_ino
    record.expectedByteSize = size
    record.expectedSha256 = digest
    record.publicationReady = false
    record.proofValid = true
    record.ownerProofDurable = false
    record.publicationDurable = false
    syncBundleAndParents(target, record, StorageStage.WITNESS_SYNC)
  }

  /** Copy to the exclusively-created inode, then independently verify bytes and sync all entries. */
  fun copyAndVerify(target: File, record: DownloadRecord, source: File) {
    val destination = audio(target, record)
    try {
      FileInputStream(source).use { input ->
        FileOutputStream(destination, false).use { output ->
          val buffer = ByteArray(64 * 1024)
          var total = 0L
          while (true) {
            val count = input.read(buffer)
            if (count < 0) break
            total += count
            if (total > DownloadEngine.MAX_BYTES || total > record.expectedByteSize) {
              throw StorageFailure.known(StorageStage.WITNESS_COPY, "UNKNOWN")
            }
            output.write(buffer, 0, count)
          }
          output.fd.sync()
        }
      }
    } catch (e: Exception) {
      if (e is DownloadError) throw e
      throw StorageFailure.wrap(StorageStage.WITNESS_COPY, e)
    }
    val (actualSize, actualDigest) = digestFile(destination, StorageStage.WITNESS_VERIFY)
    if (actualSize != record.expectedByteSize || actualDigest != record.expectedSha256) {
      throw StorageFailure.known(StorageStage.WITNESS_VERIFY, "UNKNOWN")
    }
    if (!proofMatches(target, record, checkContent = true, requireReady = false)) {
      throw StorageFailure.known(StorageStage.WITNESS_VERIFY, "UNKNOWN")
    }
    syncBundleAndParents(target, record, StorageStage.WITNESS_SYNC)
  }

  fun owns(target: File, record: DownloadRecord): Boolean =
    record.storageVersion == 2 && record.publicationReady && record.publicationDurable &&
      record.ownerProofDurable && record.durationMs in 1..3_600_000L &&
      proofMatches(target, record, checkContent = true, requireReady = true)

  fun verifyAndResync(target: File, record: DownloadRecord): Boolean {
    if (record.storageVersion != 2 || !record.proofValid || !record.hasProof() ||
      record.durationMs !in 1..3_600_000L) return false
    if (!proofMatches(target, record, checkContent = true, requireReady = true)) return false
    return try {
      syncBundleAndParents(target, record, StorageStage.WITNESS_SYNC)
      record.ownerProofDurable = true
      record.publicationDurable = true
      true
    } catch (_: Exception) {
      false
    }
  }

  /** Removes only an exact, journal-proven partial bundle; mismatches are left untouched. */
  fun cleanupPartial(target: File, record: DownloadRecord) {
    val bundle = directory(target, record)
    if (!pathExists(bundle, StorageStage.WITNESS_STAT)) {
      if (pathExists(idDirectory(target, record.recordingId), StorageStage.WITNESS_STAT)) {
        throw DownloadError("E_CLEANUP", "Unproven publication directory remains")
      }
      return
    }
    val identifierDirectory = bundle.parentFile
      ?: throw DownloadError("E_CLEANUP", "Missing publication identifier directory")
    if (!record.ownerProofDurable || !record.proofValid || !record.hasProof()) {
      throw DownloadError("E_CLEANUP", "Cannot prove ownership of partial publication files")
    }
    if (!proofMatches(target, record, checkContent = false, requireReady = false, allowMissingAudio = true)) {
      throw DownloadError("E_CLEANUP", "Partial publication provenance does not match")
    }
    val entries = bundle.list()?.toSet()
      ?: throw DownloadError("E_CLEANUP", "Cannot inspect partial publication directory")
    if (entries.any { it !in setOf(AUDIO_NAME, MARKER_NAME) } || MARKER_NAME !in entries) {
      throw DownloadError("E_CLEANUP", "Unexpected files in partial publication directory")
    }
    DownloadStore.syncDirectory(bundle, StorageStage.WITNESS_SYNC)
    val audio = audio(target, record)
    if (AUDIO_NAME in entries && !audio.delete()) throw DownloadError("E_CLEANUP", "Cannot remove partial audio")
    if (!marker(target, record).delete()) throw DownloadError("E_CLEANUP", "Cannot remove publication marker")
    DownloadStore.syncDirectory(bundle, StorageStage.WITNESS_SYNC)
    DownloadStore.syncDirectory(identifierDirectory, StorageStage.WITNESS_SYNC)
    if (bundle.list()?.isNotEmpty() != false || !bundle.delete()) {
      throw DownloadError("E_CLEANUP", "Cannot remove partial publication directory")
    }
    if (identifierDirectory.list()?.isNotEmpty() == false) {
      if (!identifierDirectory.delete()) throw DownloadError("E_CLEANUP", "Cannot remove publication identifier directory")
      val publicationRoot = identifierDirectory.parentFile
        ?: throw DownloadError("E_CLEANUP", "Missing publication root")
      DownloadStore.syncDirectory(publicationRoot, StorageStage.WITNESS_SYNC)
    } else {
      throw DownloadError("E_CLEANUP", "Unexpected entries in publication identifier directory")
    }
  }

  /** Full-proof deletion for explicit discard; never recurse or touch unrelated directory entries. */
  fun discard(target: File, record: DownloadRecord) {
    if (!owns(target, record)) {
      throw DownloadError("E_PROVENANCE", "Refusing to delete audio without complete ownership proof")
    }
    val bundle = directory(target, record)
    val entries = bundle.list()?.toSet()
      ?: throw DownloadError("E_PROVENANCE", "Cannot inspect publication directory")
    if (entries != setOf(AUDIO_NAME, MARKER_NAME) ||
      !proofMatches(target, record, checkContent = true, requireReady = true)) {
      throw DownloadError("E_PROVENANCE", "Publication files changed; refusing deletion")
    }
    DownloadStore.syncDirectory(bundle, StorageStage.WITNESS_SYNC)
    if (!audio(target, record).delete() || !marker(target, record).delete() ||
      bundle.list()?.isNotEmpty() != false) {
      throw DownloadError("E_CLEANUP", "Cannot remove owned publication files")
    }
    DownloadStore.syncDirectory(bundle, StorageStage.WITNESS_SYNC)
    if (!bundle.delete()) throw DownloadError("E_CLEANUP", "Cannot remove owned publication directory")
    val parent = bundle.parentFile ?: throw DownloadError("E_CLEANUP", "Missing publication parent")
    DownloadStore.syncDirectory(parent, StorageStage.WITNESS_SYNC)
    if (parent.list()?.isNotEmpty() == false) {
      if (!parent.delete()) throw DownloadError("E_CLEANUP", "Cannot remove publication identifier directory")
      val publicationRoot = parent.parentFile
        ?: throw DownloadError("E_CLEANUP", "Missing publication root")
      DownloadStore.syncDirectory(publicationRoot, StorageStage.WITNESS_SYNC)
    }
  }

  fun markerExists(target: File, record: DownloadRecord): Boolean =
    pathExists(marker(target, record), StorageStage.WITNESS_STAT)

  private fun proofMatches(
    target: File,
    record: DownloadRecord,
    checkContent: Boolean,
    requireReady: Boolean,
    allowMissingAudio: Boolean = false
  ): Boolean {
    if (!record.proofValid || !record.hasProof() || (requireReady && !record.publicationReady)) return false
    return try {
      val bundle = directory(target, record)
      ensureNoLinkDirectory(target)
      ensureNoLinkDirectory(root(target))
      ensureNoLinkDirectory(bundle.parentFile!!)
      val dirStat = statDirectory(bundle, StorageStage.WITNESS_STAT)
      if (dirStat.st_dev != record.directoryDevice || dirStat.st_ino != record.directoryInode) return false
      val entries = bundle.list()?.toSet() ?: return false
      val exactEntries = entries == setOf(AUDIO_NAME, MARKER_NAME) ||
        (allowMissingAudio && entries == setOf(MARKER_NAME))
      if (!exactEntries) return false
      val owner = marker(target, record)
      val markerStat = statRegular(owner, StorageStage.WITNESS_STAT)
      if (markerStat.st_size !in 1..4096) return false
      if (markerStat.st_dev != record.markerDevice || markerStat.st_ino != record.markerInode) return false
      val ownerData = FileInputStream(owner).bufferedReader(Charsets.UTF_8).use { JSONObject(it.readText()) }
      if (ownerData.keys().asSequence().toSet() != markerKeys) return false
      if (ownerData.getString("recordingId") != record.recordingId ||
        ownerData.getString("token") != record.token || ownerData.getInt("storageVersion") != 2 ||
        ownerData.getLong("directoryDevice") != record.directoryDevice ||
        ownerData.getLong("directoryInode") != record.directoryInode ||
        ownerData.getLong("audioDevice") != record.device || ownerData.getLong("audioInode") != record.inode ||
        ownerData.getLong("expectedByteSize") != record.expectedByteSize ||
        ownerData.getString("expectedSha256") != record.expectedSha256) return false
      val audio = audio(target, record)
      val audioStat = try { statRegular(audio, StorageStage.WITNESS_STAT) }
      catch (e: Exception) {
        if (allowMissingAudio && e is ErrnoException && e.errno == OsConstants.ENOENT) return true
        return false
      }
      if (audioStat.st_dev != record.device || audioStat.st_ino != record.inode) return false
      if (checkContent) {
        val (size, digest) = digestFile(audio, StorageStage.WITNESS_VERIFY)
        if (size != record.expectedByteSize || digest != record.expectedSha256) return false
      }
      true
    } catch (_: Exception) {
      false
    }
  }

  private fun markerJson(
    recordingId: String,
    token: String,
    directoryDevice: Long,
    directoryInode: Long,
    audioDevice: Long,
    audioInode: Long,
    size: Long,
    digest: String
  ) = JSONObject().put("recordingId", recordingId).put("token", token).put("storageVersion", 2)
    .put("directoryDevice", directoryDevice).put("directoryInode", directoryInode)
    .put("audioDevice", audioDevice).put("audioInode", audioInode)
    .put("expectedByteSize", size).put("expectedSha256", digest)

  private fun digestFile(file: File, stage: StorageStage): Pair<Long, String> {
    try {
      val stat = statRegular(file, stage)
      if (stat.st_size !in 1..DownloadEngine.MAX_BYTES) {
        throw StorageFailure.known(stage, "UNKNOWN")
      }
      val digest = MessageDigest.getInstance("SHA-256")
      var total = 0L
      FileInputStream(file).use { input ->
        val buffer = ByteArray(64 * 1024)
        while (true) {
          val count = input.read(buffer)
          if (count < 0) break
          total += count
          if (total > DownloadEngine.MAX_BYTES) throw StorageFailure.known(stage, "UNKNOWN")
          digest.update(buffer, 0, count)
        }
      }
      if (total != stat.st_size) throw StorageFailure.known(stage, "UNKNOWN")
      return total to digest.digest().joinToString("") { (it.toInt() and 0xff).toString(16).padStart(2, '0') }
    } catch (e: Exception) {
      if (e is DownloadError) throw e
      throw StorageFailure.wrap(stage, e)
    }
  }

  private fun canonicalToken(record: DownloadRecord): String {
    val token = try { UUID.fromString(record.token).toString() } catch (_: Exception) { "" }
    if (token != record.token) throw DownloadError("E_PROVENANCE", "Invalid publication token")
    return token
  }

  private fun statRegular(file: File, stage: StorageStage) = try {
    Os.lstat(file.absolutePath).also {
      if (!OsConstants.S_ISREG(it.st_mode)) throw StorageFailure.known(stage, "UNKNOWN")
    }
  } catch (e: Exception) {
    if (e is DownloadError) throw e
    throw StorageFailure.wrap(stage, e)
  }

  private fun statDirectory(file: File, stage: StorageStage) = try {
    Os.lstat(file.absolutePath).also {
      if (!OsConstants.S_ISDIR(it.st_mode)) throw StorageFailure.known(stage, "ENOTDIR")
    }
  } catch (e: Exception) {
    if (e is DownloadError) throw e
    throw StorageFailure.wrap(stage, e)
  }

  private fun ensureDirectoryNoLink(file: File, stage: StorageStage) {
    val stat = statDirectory(file, stage)
    if (!OsConstants.S_ISDIR(stat.st_mode)) throw StorageFailure.known(stage, "ENOTDIR")
  }

  private fun ensureNoLinkDirectory(file: File) {
    val stat = Os.lstat(file.absolutePath)
    if (!OsConstants.S_ISDIR(stat.st_mode)) throw DownloadError("E_PROVENANCE", "Publication path is not a directory")
  }

  private fun syncBundleAndParents(target: File, record: DownloadRecord, stage: StorageStage) {
    val bundle = directory(target, record)
    val parent = bundle.parentFile!!
    DownloadStore.syncDirectory(bundle, stage)
    DownloadStore.syncDirectory(parent, stage)
    DownloadStore.syncDirectory(root(target), stage)
    DownloadStore.syncDirectory(target, stage)
    target.parentFile?.let { DownloadStore.syncDirectory(it, stage) }
  }
}