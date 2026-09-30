package com.diwan.downloader

import android.content.Context
import android.net.Uri
import android.system.Os
import android.system.OsConstants
import android.util.AtomicFile
import org.json.JSONObject
import java.io.File
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
  var adopted: Boolean = false
) {
  fun json() = JSONObject().put("recordingId", recordingId).put("url", url).put("token", token)
    .put("state", state).put("progress", progress).put("durationMs", durationMs)
    .put("device", device).put("inode", inode).put("errorCode", errorCode).put("adopted", adopted)
  val terminal: Boolean get() = state !in setOf("queued", "running")
}

/** Access only under DownloadCoordinator's lock. Journal and hard-link witness are private. */
internal class DownloadStore(private val context: Context) {
  private val root = File(context.noBackupFilesDir, "diwan-download-journal")
  private val target = File(context.filesDir, "recording-audio")
  val records = linkedMapOf<String, DownloadRecord>()

  init {
    if ((!root.isDirectory && !root.mkdirs()) || (!target.isDirectory && !target.mkdirs())) {
      throw DownloadError("E_STORAGE", "Unable to create download storage")
    }
    // Include AtomicFile backup names so an interrupted first write is recovered too.
    val names = root.listFiles() ?: throw DownloadError("E_STORAGE", "Cannot read download journal")
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
          val record = DownloadRecord(id, json.getString("url"), token, json.getString("state"),
            json.getDouble("progress"), json.optLong("durationMs"), json.optLong("device"),
            json.optLong("inode"), if (json.isNull("errorCode")) null else json.getString("errorCode"),
            json.optBoolean("adopted"))
          records[id] = record
        } catch (e: Exception) {
          // Never guess ownership or erase a corrupt record.
          throw DownloadError("E_STORAGE", "Download journal is unreadable: $name", e)
        }
      }
    records.values.toList().forEach { record ->
      if (record.adopted) {
        cleanup(record)
        erase(record)
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

  fun stage(r: DownloadRecord) = File(context.cacheDir, "diwan-download-${r.token}")
  fun witness(r: DownloadRecord) = File(target, ".diwan-${r.token}.mp3")
  fun finalFile(r: DownloadRecord) = File(target, "${r.recordingId}.mp3")
  fun save(r: DownloadRecord) {
    val file = AtomicFile(File(root, "${r.recordingId}.json"))
    var stream: FileOutputStream? = null
    try {
      stream = file.startWrite()
      stream.write(r.json().toString().toByteArray(Charsets.UTF_8))
      file.finishWrite(stream)
      syncDirectory(root)
      records[r.recordingId] = r
    } catch (e: Exception) {
      file.failWrite(stream)
      throw DownloadError("E_STORAGE", "Cannot persist download state", e)
    }
  }

  fun ownsFinal(r: DownloadRecord): Boolean {
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
    val temp = witness(r)
    if (!temp.createNewFile()) throw DownloadError("E_STORAGE", "Publication witness already exists")
    source.inputStream().use { input -> FileOutputStream(temp).use { output ->
      input.copyTo(output)
      output.fd.sync()
    } }
    if (temp.length() != source.length()) throw DownloadError("E_STORAGE", "Incomplete audio copy")
    val stat = Os.lstat(temp.absolutePath)
    r.device = stat.st_dev
    r.inode = stat.st_ino
    syncDirectory(target)
    save(r) // Durable witness identity and duration BEFORE link, closing the publication crash window.
    try { Os.link(temp.absolutePath, finalFile(r).absolutePath) }
    catch (e: Exception) { throw DownloadError("E_STORAGE", "Cannot publish audio (file may already exist)", e) }
    syncDirectory(target)
    r.state = "completed"
    r.progress = 1.0
    r.errorCode = null
    save(r)
  }

  fun cleanup(r: DownloadRecord, keepWitness: Boolean = false) {
    val stage = stage(r)
    if (stage.exists() && !stage.deleteRecursively()) throw DownloadError("E_CLEANUP", "Cannot remove download staging files")
    val temp = witness(r)
    if (!keepWitness && temp.exists() && !temp.delete()) throw DownloadError("E_CLEANUP", "Cannot remove publication witness")
    syncDirectory(target)
  }

  fun remove(r: DownloadRecord, discard: Boolean) {
    if (discard && finalFile(r).exists() && !r.adopted) {
      if (ownsFinal(r)) {
        if (!finalFile(r).delete()) throw DownloadError("E_CLEANUP", "Cannot remove unadopted audio")
        syncDirectory(target)
      } else if (r.state == "completed") {
        throw DownloadError("E_PROVENANCE", "Refusing to delete audio without an ownership witness")
      }
      // Preexisting/unrelated files are NEVER deleted.
    }
    // Durable adoption/tombstone before deleting witness: a crash cannot re-enable discard.
    r.adopted = true
    save(r)
    cleanup(r)
    erase(r)
  }

  private fun erase(r: DownloadRecord) {
    AtomicFile(File(root, "${r.recordingId}.json")).delete()
    if (File(root, "${r.recordingId}.json").exists()) throw DownloadError("E_STORAGE", "Cannot remove download journal")
    syncDirectory(root)
    records.remove(r.recordingId)
  }

  fun view(r: DownloadRecord): Map<String, Any> = mutableMapOf<String, Any>(
    "recordingId" to r.recordingId, "url" to r.url, "state" to r.state, "progress" to r.progress
  ).apply {
    if (r.state == "completed") {
      put("audioUrl", Uri.fromFile(finalFile(r)).toString())
      put("durationMs", r.durationMs)
    }
    r.errorCode?.let { put("errorCode", it) }
  }

  companion object {
    fun validateId(id: String) {
      if (!Regex("[A-Za-z0-9_-]{1,100}").matches(id)) throw DownloadError("E_STORAGE", "Invalid recording ID")
    }
    fun syncDirectory(directory: File) {
      val fd = Os.open(directory.absolutePath, OsConstants.O_RDONLY or OsConstants.O_DIRECTORY, 0)
      try { Os.fsync(fd) } finally { Os.close(fd) }
    }
  }
}