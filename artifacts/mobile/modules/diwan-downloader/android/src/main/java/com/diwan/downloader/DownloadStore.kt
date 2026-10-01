package com.diwan.downloader

import android.content.Context
import android.net.Uri
import android.system.Os
import android.system.OsConstants
import android.util.AtomicFile
import org.json.JSONObject
import java.io.File
import java.io.FileNotFoundException
import java.io.FileOutputStream
import java.util.UUID

internal data class DownloadRecord(
  val recordingId: String,
  val url: String,
  val token: String = UUID.randomUUID().toString(),
  var state: String = "queued",
  var progress: Double = 0.0,
  var durationMs: Long = 0,
  var device: Long = 0,
  var inode: Long = 0,
  var errorCode: String? = null,
  var adopted: Boolean = false,
  val storageVersion: Int = 2,
  var directoryDevice: Long = 0,
  var directoryInode: Long = 0,
  var markerDevice: Long = 0,
  var markerInode: Long = 0,
  var expectedByteSize: Long = 0,
  var expectedSha256: String? = null,
  var publicationReady: Boolean = false,
  var proofValid: Boolean = true
) {
  fun json() = JSONObject().put("recordingId", recordingId).put("url", url).put("token", token)
    .put("state", state).put("progress", progress).put("durationMs", durationMs)
    .put("device", device).put("inode", inode).put("errorCode", errorCode).put("adopted", adopted)
    .put("storageVersion", storageVersion).put("directoryDevice", directoryDevice)
    .put("directoryInode", directoryInode).put("markerDevice", markerDevice).put("markerInode", markerInode)
    .put("expectedByteSize", expectedByteSize).put("expectedSha256", expectedSha256 ?: JSONObject.NULL)
    .put("publicationReady", publicationReady)

  @Transient var ownerProofDurable: Boolean = false
  @Transient var publicationDurable: Boolean = false
  fun hasProof(): Boolean = directoryDevice > 0 && directoryInode > 0 && markerDevice > 0 &&
    markerInode > 0 && device > 0 && inode > 0 && expectedByteSize in 1..DownloadEngine.MAX_BYTES &&
    expectedSha256?.matches(Regex("[0-9a-f]{64}")) == true
  val terminal: Boolean get() = state !in setOf("queued", "running")
}

/** Access only under DownloadCoordinator's lock. Journal and hard-link witness are private. */
internal open class DownloadStore(private val context: Context) {
  private val root = File(context.noBackupFilesDir, "diwan-download-journal")
  private val target = File(context.filesDir, "recording-audio")
  val records = linkedMapOf<String, DownloadRecord>()

  init {
    ensureDirectory(root)
    ensureDirectory(target)
    // Include AtomicFile backup names so an interrupted first write is recovered too.
    val names = try { root.listFiles() }
      catch (e: Exception) { throw StorageFailure.wrap(StorageStage.JOURNAL_READ, e) }
      ?: throw StorageFailure.known(StorageStage.JOURNAL_READ, "UNKNOWN")
    // A .new without base/backup is an uncommitted first write: no work was authorized.
    names.filter { it.name.endsWith(".json.new") }.forEach {
      val base = File(root, it.name.removeSuffix(".new"))
      if (!base.exists() && !File(root, "${base.name}.bak").exists() && !it.delete()) {
        throw DownloadError("E_CLEANUP", "Cannot remove uncommitted journal write")
      }
    }
    names.map { it.name.removeSuffix(".bak") }
      .filter { it.endsWith(".json") }.distinct().forEach { name ->
        try {
          val json = AtomicFile(File(root, name)).openRead().bufferedReader().use { JSONObject(it.readText()) }
          val id = json.getString("recordingId")
          validateId(id)
          val token = json.getString("token")
          UUID.fromString(token)
          if (name != "$id.json" || token != UUID.fromString(token).toString()) error("Invalid journal identity")
          val version = if (json.has("storageVersion")) json.getInt("storageVersion") else 1
          val record = DownloadRecord(id, json.getString("url"), token, json.getString("state"),
            json.getDouble("progress"), json.optLong("durationMs"), json.optLong("device"),
            json.optLong("inode"), if (json.isNull("errorCode")) null else json.getString("errorCode"),
            json.optBoolean("adopted"), version, json.optLong("directoryDevice"), json.optLong("directoryInode"),
            json.optLong("markerDevice"), json.optLong("markerInode"), json.optLong("expectedByteSize"),
            if (json.isNull("expectedSha256")) null else json.getString("expectedSha256"),
            json.optBoolean("publicationReady"), proofFieldsValid(json, version))
          records[id] = record
        } catch (e: Exception) {
          // Never guess ownership or erase a corrupt record.
          if (e is DownloadError) throw e
          if (e is FileNotFoundException) throw StorageFailure.known(StorageStage.JOURNAL_READ, "ENOENT")
          throw StorageFailure.wrap(StorageStage.JOURNAL_READ, e)
        }
      }
    records.values.toList().forEach { record ->
      if (record.storageVersion !in setOf(1, 2)) {
        // Unknown formats are never interpreted as legacy and never authorize cleanup.
        record.state = "failed"
        record.errorCode = "E_PROVENANCE"
        return@forEach
      }
      if (record.storageVersion == 2 && !record.proofValid) {
        record.state = "failed"
        record.errorCode = "E_PROVENANCE"
        return@forEach
      }
      if (record.storageVersion == 2 && record.hasProof()) record.ownerProofDurable = true
      if (record.adopted) {
        // An acknowledgement tombstone deliberately leaves the saved audio and its proof in place.
        if (record.storageVersion == 1) cleanup(record)
        else cleanupStage(record)
        erase(record)
      } else if (record.storageVersion == 2) {
        if (record.publicationReady && TokenPublication.verifyAndResync(target, record)) {
          record.state = "completed"
          record.progress = 1.0
          record.errorCode = null
        } else if (record.publicationReady) {
          record.state = "failed"
          record.errorCode = "E_PROVENANCE"
        } else if (!record.terminal) {
          record.state = "interrupted"
          record.errorCode = "E_INTERRUPTED"
        } else if (record.state == "completed") {
          record.state = "failed"
          record.errorCode = "E_PROVENANCE"
        }
        save(record)
        try {
          if (!record.publicationReady) TokenPublication.cleanupPartial(target, record)
          cleanupStage(record)
        } catch (_: Exception) {
          record.errorCode = "E_CLEANUP"
          save(record)
        }
      } else {
        if (ownsFinal(record)) {
          record.state = "completed"
          record.progress = 1.0
          record.errorCode = null
        } else if (!record.terminal) {
          record.state = "interrupted"
          record.errorCode = "E_INTERRUPTED"
        } else if (record.state == "completed") {
          record.state = "failed"
          record.errorCode = "E_PROVENANCE"
        }
        save(record)
        try { cleanup(record, keepWitness = record.state == "completed") }
        catch (_: Exception) { record.errorCode = "E_CLEANUP"; save(record) }
      }
    }
  }

  private fun proofFieldsValid(json: JSONObject, version: Int): Boolean {
    if (version != 2) return true
    val names = setOf("directoryDevice", "directoryInode", "markerDevice", "markerInode",
      "expectedByteSize", "expectedSha256", "publicationReady")
    val present = names.count { json.has(it) }
    if (present == 0) return true // A new operation may be interrupted before its owner proof exists.
    if (present != names.size) return false
    if (listOf("device", "inode", "directoryDevice", "directoryInode", "markerDevice", "markerInode", "expectedByteSize")
        .any { json.opt(it) !is Number } || json.opt("publicationReady") !is Boolean) return false
    if (!json.isNull("expectedSha256") && json.opt("expectedSha256") !is String) return false
    val expected = if (json.isNull("expectedSha256")) null else json.getString("expectedSha256")
    val anyIdentity = json.optLong("directoryDevice") != 0L || json.optLong("directoryInode") != 0L ||
      json.optLong("markerDevice") != 0L || json.optLong("markerInode") != 0L ||
      json.optLong("device") != 0L || json.optLong("inode") != 0L ||
      json.optLong("expectedByteSize") != 0L || expected != null
    return !anyIdentity || (json.optLong("directoryDevice") > 0 && json.optLong("directoryInode") > 0 &&
      json.optLong("markerDevice") > 0 && json.optLong("markerInode") > 0 &&
      json.optLong("device") > 0 && json.optLong("inode") > 0 &&
      json.optLong("expectedByteSize") in 1..DownloadEngine.MAX_BYTES &&
      expected?.matches(Regex("[0-9a-f]{64}")) == true)
  }

  private fun ensureDirectory(directory: File) {
    try {
      if (directory.exists() && !directory.isDirectory) {
        throw StorageFailure.known(StorageStage.STORE_INIT, "ENOTDIR")
      }
      if (!directory.isDirectory && !directory.mkdirs()) {
        throw StorageFailure.known(StorageStage.STORE_INIT, "UNKNOWN")
      }
      if (!directory.isDirectory) throw StorageFailure.known(StorageStage.STORE_INIT, "UNKNOWN")
    } catch (e: DownloadError) {
      throw e
    } catch (e: Exception) {
      throw StorageFailure.wrap(StorageStage.STORE_INIT, e)
    }
  }

  fun stage(r: DownloadRecord) = File(context.cacheDir, "diwan-download-${r.token}")
  fun witness(r: DownloadRecord) = File(target, ".diwan-${r.token}.mp3")
  fun finalFile(r: DownloadRecord) = when (r.storageVersion) {
    1 -> File(target, "${r.recordingId}.mp3")
    2 -> TokenPublication.audio(target, r)
    else -> throw DownloadError("E_PROVENANCE", "Unsupported publication format")
  }
  fun flatFile(recordingId: String) = File(target, "$recordingId.mp3")
  fun hasStartCollision(recordingId: String): Boolean =
    TokenPublication.pathExists(flatFile(recordingId), StorageStage.AUDIO_EXISTS) ||
      TokenPublication.pathExists(TokenPublication.idDirectory(target, recordingId), StorageStage.AUDIO_EXISTS)
  open fun save(r: DownloadRecord, stage: StorageStage = StorageStage.JOURNAL_WRITE) {
    val file = AtomicFile(File(root, "${r.recordingId}.json"))
    var stream: FileOutputStream? = null
    try {
      stream = file.startWrite()
      stream.write(r.json().toString().toByteArray(Charsets.UTF_8))
      file.finishWrite(stream)
      syncDirectory(root, stage)
      records[r.recordingId] = r
    } catch (e: Exception) {
      try {
        file.failWrite(stream)
      } catch (failure: Exception) {
        if (e !is DownloadError) failure.addSuppressed(e)
        throw StorageFailure.wrap(stage, failure)
      }
      if (e is DownloadError) throw e
      throw StorageFailure.wrap(stage, e)
    }
  }

  fun ownsFinal(r: DownloadRecord): Boolean {
    if (r.storageVersion == 2) return TokenPublication.owns(target, r)
    if (r.storageVersion != 1) return false
    if (r.inode == 0L || r.durationMs <= 0) return false
    return try {
      val a = Os.lstat(witness(r).absolutePath)
      val b = Os.lstat(finalFile(r).absolutePath)
      OsConstants.S_ISREG(a.st_mode) && OsConstants.S_ISREG(b.st_mode) &&
        a.st_ino == r.inode && a.st_dev == r.device &&
        b.st_ino == a.st_ino && b.st_dev == a.st_dev && a.st_size in 1..DownloadEngine.MAX_BYTES
    } catch (_: Exception) { false }
  }

  fun publish(r: DownloadRecord) {
    val source = File(stage(r), "audio.mp3")
    if (r.storageVersion == 2) {
      try { TokenPublication.prepare(target, r, source) }
      catch (e: Exception) {
        clearProof(r)
        throw e
      }
      try {
        save(r, StorageStage.PUBLICATION_JOURNAL)
        r.ownerProofDurable = true
      } catch (e: Exception) {
        // A marker without a durable journal identity is intentionally not cleanup authority.
        clearProof(r)
        throw e
      }
      TokenPublication.copyAndVerify(target, r, source)
      r.publicationReady = true
      try {
        save(r, StorageStage.PUBLICATION_JOURNAL)
        r.publicationDurable = true
      } catch (e: Exception) {
        r.publicationReady = false
        r.publicationDurable = false
        throw e
      }
      r.state = "completed"
      r.progress = 1.0
      r.errorCode = null
      save(r, StorageStage.COMPLETION_JOURNAL)
      return
    }
    if (r.storageVersion != 1) throw DownloadError("E_PROVENANCE", "Unsupported publication format")
    val temp = witness(r)
    val created = try { temp.createNewFile() }
      catch (e: Exception) { throw StorageFailure.wrap(StorageStage.WITNESS_CREATE, e) }
    if (!created) throw StorageFailure.known(StorageStage.WITNESS_CREATE, "EEXIST")
    if (!source.exists()) throw StorageFailure.known(StorageStage.WITNESS_COPY, "ENOENT")
    try {
      source.inputStream().use { input -> FileOutputStream(temp).use { output -> input.copyTo(output) } }
    } catch (e: Exception) {
      throw StorageFailure.wrap(StorageStage.WITNESS_COPY, e)
    }
    try {
      FileOutputStream(temp, true).use { it.fd.sync() }
    } catch (e: Exception) {
      throw StorageFailure.wrap(StorageStage.WITNESS_SYNC, e)
    }
    if (!source.exists()) throw StorageFailure.known(StorageStage.WITNESS_VERIFY, "ENOENT")
    val verified = try { temp.length() == source.length() }
      catch (e: Exception) { throw StorageFailure.wrap(StorageStage.WITNESS_VERIFY, e) }
    if (!verified) throw StorageFailure.known(StorageStage.WITNESS_VERIFY, "UNKNOWN")
    val stat = try { Os.lstat(temp.absolutePath) }
      catch (e: Exception) { throw StorageFailure.wrap(StorageStage.WITNESS_STAT, e) }
    r.device = stat.st_dev
    r.inode = stat.st_ino
    syncDirectory(target, StorageStage.WITNESS_SYNC)
    save(r, StorageStage.PUBLICATION_JOURNAL) // Durable witness identity and duration BEFORE link, closing the publication crash window.
    try { Os.link(temp.absolutePath, finalFile(r).absolutePath) }
    catch (e: Exception) { throw StorageFailure.wrap(StorageStage.PUBLICATION_LINK, e) }
    syncDirectory(target, StorageStage.PUBLICATION_LINK)
    r.state = "completed"
    r.progress = 1.0
    r.errorCode = null
    save(r, StorageStage.COMPLETION_JOURNAL)
  }

  fun cleanup(r: DownloadRecord, keepWitness: Boolean = false) {
    cleanupStage(r)
    if (r.storageVersion == 2) {
      if (r.adopted || r.state == "completed" || (r.publicationReady && r.publicationDurable)) return
      TokenPublication.cleanupPartial(target, r)
      return
    }
    if (r.storageVersion != 1) return
    val temp = witness(r)
    if (!keepWitness && temp.exists() && !temp.delete()) throw DownloadError("E_CLEANUP", "Cannot remove publication witness")
    syncDirectory(target, StorageStage.WITNESS_SYNC)
  }

  private fun cleanupStage(r: DownloadRecord) {
    val staging = stage(r)
    if (staging.exists() && !staging.deleteRecursively()) {
      throw DownloadError("E_CLEANUP", "Cannot remove download staging files")
    }
  }

  fun remove(r: DownloadRecord, discard: Boolean) {
    if (discard && r.storageVersion == 2 && !r.adopted) {
      if (r.state == "completed") TokenPublication.discard(target, r)
      else if (TokenPublication.markerExists(target, r)) {
        throw DownloadError("E_PROVENANCE", "Refusing to delete an incomplete publication")
      }
    } else if (discard && r.storageVersion == 1 && finalFile(r).exists() && !r.adopted) {
      if (ownsFinal(r)) {
        if (!finalFile(r).delete()) throw DownloadError("E_CLEANUP", "Cannot remove unadopted audio")
        syncDirectory(target, StorageStage.WITNESS_SYNC)
      } else if (r.state == "completed") {
        throw DownloadError("E_PROVENANCE", "Refusing to delete audio without an ownership witness")
      }
      // Preexisting/unrelated files are NEVER deleted.
    }
    // Durable adoption/tombstone before deleting witness: a crash cannot re-enable discard.
    r.adopted = true
    save(r)
    if (r.storageVersion == 1) cleanup(r) else cleanupStage(r)
    erase(r)
  }

  private fun erase(r: DownloadRecord) {
    try {
      AtomicFile(File(root, "${r.recordingId}.json")).delete()
      if (File(root, "${r.recordingId}.json").exists()) {
        throw StorageFailure.known(StorageStage.JOURNAL_DELETE, "UNKNOWN")
      }
    } catch (e: Exception) {
      if (e is DownloadError) throw e
      throw StorageFailure.wrap(StorageStage.JOURNAL_DELETE, e)
    }
    syncDirectory(root, StorageStage.JOURNAL_DELETE)
    records.remove(r.recordingId)
  }

  fun view(r: DownloadRecord): Map<String, Any> = mutableMapOf<String, Any>(
    "recordingId" to r.recordingId, "url" to r.url, "state" to r.state, "progress" to r.progress
  ).apply {
    if (r.state == "completed") {
      put("audioUrl", Uri.fromFile(finalFile(r)).toString())
      put("durationMs", r.durationMs)
    }
    if (r.storageVersion == 2) {
      put("storageVersion", 2)
      put("token", r.token)
    }
    r.errorCode?.let { put("errorCode", it) }
  }

  private fun clearProof(r: DownloadRecord) {
    r.device = 0
    r.inode = 0
    r.directoryDevice = 0
    r.directoryInode = 0
    r.markerDevice = 0
    r.markerInode = 0
    r.expectedByteSize = 0
    r.expectedSha256 = null
    r.publicationReady = false
    r.proofValid = true
    r.ownerProofDurable = false
    r.publicationDurable = false
  }

  companion object {
    fun validateId(id: String) {
      if (!Regex("[A-Za-z0-9_-]{1,100}").matches(id)) throw DownloadError("E_STORAGE", "Invalid recording identifier")
    }
    fun syncDirectory(directory: File, stage: StorageStage = StorageStage.JOURNAL_SYNC) {
      var fd: java.io.FileDescriptor? = null
      var failure: Exception? = null
      try {
        val opened = Os.open(directory.absolutePath, OsConstants.O_RDONLY, 0)
        fd = opened
        if (!OsConstants.S_ISDIR(Os.fstat(opened).st_mode)) {
          throw StorageFailure.known(stage, "ENOTDIR")
        }
        Os.fsync(opened)
      } catch (e: Exception) {
        failure = e
      }
      fd?.let { opened ->
        try { Os.close(opened) }
        catch (e: Exception) { if (failure == null) failure = e }
      }
      failure?.let {
        if (it is DownloadError) throw it
        throw StorageFailure.wrap(stage, it)
      }
    }
  }
}