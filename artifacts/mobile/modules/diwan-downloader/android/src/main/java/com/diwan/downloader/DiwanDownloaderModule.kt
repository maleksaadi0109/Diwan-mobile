package com.diwan.downloader

import android.app.Activity
import android.app.Application
import android.os.Bundle
import com.facebook.react.bridge.ReactContext
import com.facebook.react.common.LifecycleState
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/** No worker belongs to React/Expo. Destroying this adapter never cancels a service. */
class DiwanDownloaderModule : Module() {
  @Volatile private var resumed: Activity? = null
  private var application: Application? = null
  private val lifecycle = object : Application.ActivityLifecycleCallbacks {
    override fun onActivityResumed(activity: Activity) { resumed = activity }
    override fun onActivityPaused(activity: Activity) { if (resumed === activity) resumed = null }
    override fun onActivityDestroyed(activity: Activity) { if (resumed === activity) resumed = null }
    override fun onActivityCreated(activity: Activity, state: Bundle?) {}
    override fun onActivityStarted(activity: Activity) {}
    override fun onActivityStopped(activity: Activity) {}
    override fun onActivitySaveInstanceState(activity: Activity, state: Bundle) {}
  }

  override fun definition() = ModuleDefinition {
    Name("DiwanDownloader")
    OnCreate {
      application = appContext.reactContext?.applicationContext as? Application
      application?.registerActivityLifecycleCallbacks(lifecycle)
      // Expo's module may be created after onResume. Its lifecycle state is authoritative.
      if ((appContext.reactContext as? ReactContext)?.lifecycleState == LifecycleState.RESUMED) {
        resumed = appContext.currentActivity
      }
    }
    AsyncFunction("start") { url: String, recordingId: String ->
      val context = appContext.reactContext ?: throw Exceptions.AppContextLost()
      if (resumed == null || resumed !== appContext.currentActivity ||
        (context as? ReactContext)?.lifecycleState != LifecycleState.RESUMED) {
        throw DownloadError("E_FOREGROUND_REQUIRED", "Open the app before starting a download")
      }
      DownloadCoordinator.start(context.applicationContext, url, recordingId)
    }
    AsyncFunction("list") {
      val context = appContext.reactContext ?: throw Exceptions.AppContextLost()
      DownloadCoordinator.list(context.applicationContext)
    }
    AsyncFunction("cancel") { id: String ->
      val context = appContext.reactContext ?: throw Exceptions.AppContextLost()
      DownloadCoordinator.cancel(context.applicationContext, id)
    }
    AsyncFunction("acknowledge") { id: String ->
      val context = appContext.reactContext ?: throw Exceptions.AppContextLost()
      DownloadCoordinator.remove(context.applicationContext, id, false)
    }
    AsyncFunction("discard") { id: String ->
      val context = appContext.reactContext ?: throw Exceptions.AppContextLost()
      DownloadCoordinator.remove(context.applicationContext, id, true)
    }
    OnDestroy {
      application?.unregisterActivityLifecycleCallbacks(lifecycle)
      resumed = null
    }
  }
}