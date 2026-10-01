package com.diwan.downloader

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager

class DownloadService : Service() {
  companion object {
    const val START = "com.diwan.downloader.START"
    const val CANCEL = "com.diwan.downloader.CANCEL"
    const val ID = "recordingId"
    const val TOKEN = "token"
    private const val CHANNEL = "diwan-audio-downloads"
    private const val NOTIFICATION = 7361
  }
  private val handler = Handler(Looper.getMainLooper())
  private var currentId: String? = null
  private var currentToken: String? = null
  private var wakeLock: PowerManager.WakeLock? = null
  private var foreground = false
  private var serviceStartId = 0
  private var deadline: Runnable? = null

  override fun onCreate() {
    super.onCreate()
    if (Build.VERSION.SDK_INT >= 26) {
      getSystemService(NotificationManager::class.java).createNotificationChannel(
        NotificationChannel(CHANNEL, "تنزيل الصوت", NotificationManager.IMPORTANCE_LOW)
          .apply { description = "تقدم تنزيل الصوت وإلغاؤه"; setSound(null, null) }
      )
    }
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    serviceStartId = startId
    val id = intent?.getStringExtra(ID)
    val token = intent?.getStringExtra(TOKEN)
    if (id == null || token == null) {
      if (currentId == null) stopSelf(startId)
      return START_NOT_STICKY
    }
    if (intent.action == CANCEL) {
      try { DownloadCoordinator.cancel(applicationContext, id, token) }
      catch (_: Exception) { android.util.Log.e("DiwanDownloader", "Cannot persist notification cancellation") }
      if (currentId == id && currentToken == token) finishTransfer(id, token)
      else if (currentId == null) stopSelf(startId)
      return START_NOT_STICKY
    }
    if (intent.action != START) return START_NOT_STICKY
    // A stale start must not replace the notification/wakelock of another transfer.
    if (currentId != null && (currentId != id || currentToken != token)) {
      if (!DownloadCoordinator.canAttach(applicationContext, id, token)) return START_NOT_STICKY
      release()
    }
    currentId = id
    currentToken = token
    try {
      val notification = notification(id, token, 0.0)
      if (Build.VERSION.SDK_INT >= 29) {
        startForeground(NOTIFICATION, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
      } else startForeground(NOTIFICATION, notification)
      foreground = true
      if (wakeLock == null) {
        wakeLock = (getSystemService(POWER_SERVICE) as PowerManager)
          .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "$packageName:audio-download")
          .apply { setReferenceCounted(false); acquire(DownloadEngine.WALL_MS + 5_000) }
        val timeout = Runnable {
          try { DownloadCoordinator.timeout(applicationContext, id, token, "E_TIMEOUT") }
          catch (_: Exception) { android.util.Log.e("DiwanDownloader", "Cannot persist service timeout") }
          finally { finishTransfer(id, token) }
        }
        deadline = timeout
        handler.postDelayed(timeout, DownloadEngine.WALL_MS)
      }
      if (!DownloadCoordinator.launch(this, id, token)) finishTransfer(id, token)
    } catch (e: Exception) {
      try { DownloadCoordinator.timeout(applicationContext, id, token, "E_SERVICE_START") }
      catch (_: Exception) { android.util.Log.e("DiwanDownloader", "Cannot persist service failure") }
      finishTransfer(id, token)
    }
    return START_NOT_STICKY // No OS restart of work and no boot receiver.
  }

  private fun notification(id: String, token: String, progress: Double): Notification {
    val cancel = Intent(this, DownloadService::class.java).setAction(CANCEL)
      .putExtra(ID, id).putExtra(TOKEN, token)
      .setData(android.net.Uri.parse("diwan-download://cancel/$token"))
    val cancelIntent = PendingIntent.getService(this, 0, cancel,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    val builder = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, CHANNEL)
      else @Suppress("DEPRECATION") Notification.Builder(this)
    builder.setSmallIcon(android.R.drawable.stat_sys_download)
      .setContentTitle("جارٍ تنزيل الصوت")
      .setContentText(if (progress == 0.0) "تجهيز التنزيل…" else "${(progress * 100).toInt()}%")
      .setOnlyAlertOnce(true).setOngoing(true).setCategory(Notification.CATEGORY_PROGRESS)
      .setProgress(100, (progress * 100).toInt(), progress == 0.0)
      .addAction(Notification.Action.Builder(null, "إلغاء", cancelIntent).build())
    packageManager.getLaunchIntentForPackage(packageName)?.let { launch ->
      builder.setContentIntent(PendingIntent.getActivity(this, 0, launch,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
    }
    return builder.build()
  }

  internal fun showProgress(id: String, token: String, progress: Double) {
    handler.post {
      if (foreground && currentId == id && currentToken == token) {
        getSystemService(NotificationManager::class.java).notify(NOTIFICATION, notification(id, token, progress))
      }
    }
  }

  internal fun finishTransfer(id: String, token: String) {
    handler.post {
      if (currentId == id && currentToken == token) {
        release()
        currentId = null
        currentToken = null
        stopSelfResult(serviceStartId)
      }
    }
  }

  // Android 15 dataSync budget callback (requires compileSdk >= 35).
  override fun onTimeout(startId: Int, fgsType: Int) {
    val id = currentId
    val token = currentToken
    if (id != null && token != null) {
      try { DownloadCoordinator.timeout(applicationContext, id, token, "E_FGS_TIMEOUT") }
      catch (_: Exception) { android.util.Log.e("DiwanDownloader", "Cannot persist Android timeout") }
    }
    release()
    currentId = null
    currentToken = null
    stopSelf()
  }

  private fun release() {
    deadline?.let { handler.removeCallbacks(it) }
    deadline = null
    wakeLock?.let { if (it.isHeld) it.release() }
    wakeLock = null
    if (foreground) stopForeground(STOP_FOREGROUND_REMOVE)
    foreground = false
  }

  override fun onDestroy() {
    // Unexpected service destruction cancels, but never deletes a published completion.
    val id = currentId
    val token = currentToken
    if (id != null && token != null) {
      try { DownloadCoordinator.timeout(applicationContext, id, token, "E_SERVICE_STOPPED") }
      catch (_: Exception) { android.util.Log.e("DiwanDownloader", "Cannot persist service destruction") }
    }
    release()
    super.onDestroy()
  }

  override fun onBind(intent: Intent?): IBinder? = null
}