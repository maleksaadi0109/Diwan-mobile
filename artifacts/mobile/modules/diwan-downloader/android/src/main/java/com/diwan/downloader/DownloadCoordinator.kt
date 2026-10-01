package com.diwan.downloader

import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.SystemClock
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/** Process-wide serialization includes initialization/engine verification, cancellation, publication and adoption. */
internal object DownloadCoordinator {
  private val lock = Any()
  private var store: DownloadStore? = null
  private var active: Transfer? = null
  private fun store(context: Context): DownloadStore =
    store ?: DownloadStore(context).also { store = it }

  fun list(context: Context): List<Map<String, Any>> = synchronized(lock) {
    val s = store(context)
    s.records.values.filter { !it.adopted }.map { s.view(it) }
  }

  fun start(context: Context, url: String, id: String): Unit = synchronized(lock) {
    DownloadStore.validateId(id)
    val canonical = DownloadEngine.canonicalUrl(url)
    val s = store(context)
    s.records[id]?.let {
      if (it.url != canonical) throw DownloadError("E_ID_CONFLICT", "Recording ID belongs to another URL")
      return@synchronized // Retrying any durable ID is idempotent, including terminal records.
    }
    if (active != null || s.records.values.any { !it.terminal }) {
      throw DownloadError("E_BUSY", "Another audio download is in progress")
    }
    val r = DownloadRecord(id, canonical)
    if (s.finalFile(r).exists()) throw DownloadError("E_STORAGE", "Audio already exists for this recording")
    s.save(r)
    try {
      val intent = Intent(context, DownloadService::class.java).setAction(DownloadService.START)
        .putExtra(DownloadService.ID, id).putExtra(DownloadService.TOKEN, r.token)
      if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent) else context.startService(intent)
    } catch (e: Exception) {
      r.state = "failed"
      r.errorCode = "E_SERVICE_START"
      s.save(r)
      throw DownloadError("E_SERVICE_START", "Cannot start foreground download service", e)
    }
    Unit
  }

  fun cancel(context: Context, id: String, token: String? = null) = synchronized(lock) {
    val s = store(context)
    val r = s.records[id] ?: return@synchronized
    if (token != null && token != r.token) return@synchronized
    if (r.terminal) return@synchronized // Especially completed: never remove a saved/awaiting-save MP3.
    active?.takeIf { it.record === r }?.let { it.cancelled.set(true) }
    r.state = "cancelled"
    r.errorCode = "E_CANCELLED"
    s.save(r)
    if (active?.record !== r) s.cleanup(r)
  }

  fun remove(context: Context, id: String, discard: Boolean) = synchronized(lock) {
    val s = store(context)
    val r = s.records[id] ?: return@synchronized
    if (!r.terminal || active?.record === r) throw DownloadError("E_BUSY", "Download is still releasing engine resources")
    s.remove(r, discard)
  }

  fun timeout(context: Context, id: String, token: String, code: String) = synchronized(lock) {
    val s = store(context)
    val r = s.records[id] ?: return@synchronized
    if (r.token != token || r.state == "completed") return@synchronized
    active?.takeIf { it.record === r }?.let {
      it.reason = code
      it.cancelled.set(true)
    }
    if (!r.terminal) {
      r.state = "failed"
      r.errorCode = code
      s.save(r)
    }
  }

  fun canAttach(context: Context, id: String, token: String): Boolean = synchronized(lock) {
    val r = store(context).records[id]
    r != null && r.token == token && !r.terminal &&
      (active == null || active?.record === r)
  }

  fun launch(service: DownloadService, id: String, token: String): Boolean = synchronized(lock) {
    val s = store(service)
    val r = s.records[id] ?: return@synchronized false
    if (r.token != token || r.terminal) return@synchronized false
    if (active != null) return@synchronized active?.record === r
    val transfer = Transfer(r)
    active = transfer
    r.state = "running"
    try { s.save(r) } catch (e: Exception) { active = null; throw e }
    val context = service.applicationContext
    val started = SystemClock.elapsedRealtime()
    val monitor = Executors.newSingleThreadScheduledExecutor { task ->
      Thread(task, "diwan-download-watchdog").apply { isDaemon = true }
    }
    // This starts before engine initialization; the service and wakelock have finite lifetimes
    // even if native initialization ignores interruption. Engine ownership is retained.
    monitor.scheduleAtFixedRate({
      try {
        val expired = SystemClock.elapsedRealtime() - started >= DownloadEngine.WALL_MS
        val oversized = s.stage(r).walkTopDown().filter { it.isFile }.sumOf { it.length() } > DownloadEngine.MAX_BYTES
        if (expired || oversized) {
          try { timeout(context, id, token, if (expired) "E_TIMEOUT" else "E_SIZE_LIMIT") }
          finally { service.finishTransfer(id, token) }
        }
        if (transfer.cancelled.get()) {
          DownloadEngine.kill(transfer) // Repeated: handles cancel racing execute's process registration.
          service.finishTransfer(id, token)
        }
      } catch (e: Exception) {
        android.util.Log.e("DiwanDownloader", "Download watchdog failed", e)
      }
    }, 0, 500, TimeUnit.MILLISECONDS)
    thread(name = "diwan-download-engine", isDaemon = true) {
      try {
        val duration = DownloadEngine.run(context, transfer, s.stage(r)) { progress ->
          synchronized(lock) {
            transfer.check()
            // Persist at whole-percent boundaries to avoid excessive flash writes.
            if ((progress * 100).toInt() > (r.progress * 100).toInt()) {
              r.progress = progress
              s.save(r)
              service.showProgress(id, token, progress)
            }
          }
        }
        synchronized(lock) {
          transfer.check()
          r.durationMs = duration
          s.publish(r)
        }
      } catch (e: Exception) {
        synchronized(lock) {
          // A successful link followed by failed journal write is still a valid completion.
          if (s.ownsFinal(r)) {
            r.state = "completed"; r.progress = 1.0; r.errorCode = null
          } else if (!r.terminal) {
            r.state = if (transfer.cancelled.get() && transfer.reason == "E_CANCELLED") "cancelled" else "failed"
            val message = e.message.orEmpty()
            r.errorCode = if (transfer.cancelled.get()) transfer.reason else
              (e as? DownloadError)?.errorCode ?: if (listOf("login", "sign in", "cookies").any { message.contains(it, true) })
                "E_LOGIN_REQUIRED" else "E_DOWNLOAD_FAILED"
          }
          try { s.save(r) } catch (failure: Exception) {
            android.util.Log.e("DiwanDownloader", "Cannot persist terminal download state", failure)
          }
        }
      } finally {
        monitor.shutdownNow()
        synchronized(lock) {
          try { s.cleanup(r, keepWitness = s.ownsFinal(r)) }
          catch (e: Exception) {
            r.errorCode = "E_CLEANUP"
            try { s.save(r) } catch (failure: Exception) {
              android.util.Log.e("DiwanDownloader", "Cannot persist cleanup failure", failure)
            }
          }
          active = null
        }
        service.finishTransfer(id, token)
      }
    }
    true
  }
}