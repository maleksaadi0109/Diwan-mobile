package com.diwan.downloader

import android.system.ErrnoException
import android.system.OsConstants
import android.util.Log
import java.util.Collections
import java.util.IdentityHashMap

/** Closed diagnostic vocabulary: never include paths, journal content, or exception text. */
internal enum class StorageStage(val code: String) {
  STORE_INIT("STORE_INIT"),
  JOURNAL_READ("JOURNAL_READ"),
  JOURNAL_WRITE("JOURNAL_WRITE"),
  JOURNAL_SYNC("JOURNAL_SYNC"),
  JOURNAL_DELETE("JOURNAL_DELETE"),
  PROGRESS_SAVE("PROGRESS_SAVE"),
  STAGE_CREATE("STAGE_CREATE"),
  AUDIO_EXISTS("AUDIO_EXISTS"),
  WITNESS_CREATE("WITNESS_CREATE"),
  WITNESS_COPY("WITNESS_COPY"),
  WITNESS_VERIFY("WITNESS_VERIFY"),
  WITNESS_STAT("WITNESS_STAT"),
  WITNESS_SYNC("WITNESS_SYNC"),
  PUBLICATION_LINK("PUBLICATION_LINK"),
  PUBLICATION_JOURNAL("PUBLICATION_JOURNAL"),
  COMPLETION_JOURNAL("COMPLETION_JOURNAL"),
  ENGINE_INSTALL_SYNC("ENGINE_INSTALL_SYNC")
}

internal object StorageFailure {
  private const val PREFIX = "E_STORAGE_STAGE_ERRNO"
  private const val TAG = "DiwanDownloader"

  private val allowedErrnos = setOf(
    "ENOSPC", "EDQUOT", "EACCES", "EPERM", "EROFS", "EEXIST", "ENOENT",
    "EXDEV", "EOPNOTSUPP", "EIO", "ENOTDIR", "UNKNOWN"
  )

  fun wrap(stage: StorageStage, cause: Exception): DownloadError =
    diagnostic(stage, errnoName(cause), cause)

  fun known(stage: StorageStage, errno: String): DownloadError =
    diagnostic(stage, if (errno in allowedErrnos) errno else "UNKNOWN", null)

  fun isDiagnostic(code: String): Boolean = code.startsWith("$PREFIX:")

  private fun diagnostic(stage: StorageStage, errno: String, cause: Throwable?): DownloadError {
    val safeErrno = if (errno in allowedErrnos) errno else "UNKNOWN"
    val code = "$PREFIX:${stage.code}:$safeErrno"
    Log.e(TAG, code)
    return DownloadError(code, "Unable to complete a device storage operation", cause)
  }

  private fun errnoName(cause: Throwable): String {
    val seen = Collections.newSetFromMap(IdentityHashMap<Throwable, Boolean>())
    var current: Throwable? = cause
    repeat(16) {
      val item = current ?: return "UNKNOWN"
      if (!seen.add(item)) return "UNKNOWN"
      if (item is ErrnoException) {
        return when (item.errno) {
          OsConstants.ENOSPC -> "ENOSPC"
          OsConstants.EDQUOT -> "EDQUOT"
          OsConstants.EACCES -> "EACCES"
          OsConstants.EPERM -> "EPERM"
          OsConstants.EROFS -> "EROFS"
          OsConstants.EEXIST -> "EEXIST"
          OsConstants.ENOENT -> "ENOENT"
          OsConstants.EXDEV -> "EXDEV"
          OsConstants.EOPNOTSUPP -> "EOPNOTSUPP"
          OsConstants.EIO -> "EIO"
          OsConstants.ENOTDIR -> "ENOTDIR"
          else -> "UNKNOWN"
        }
      }
      current = item.cause
    }
    return "UNKNOWN"
  }
}