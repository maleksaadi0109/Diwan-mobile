package com.diwan.downloader

import android.system.ErrnoException
import android.system.OsConstants
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import java.io.IOException

@RunWith(AndroidJUnit4::class)
class StorageFailureTest {
  @Test fun mapsOnlyAllowlistedAndroidErrnosThroughCauses() {
    val expected = listOf(
      OsConstants.ENOSPC to "ENOSPC",
      OsConstants.EDQUOT to "EDQUOT",
      OsConstants.EACCES to "EACCES",
      OsConstants.EPERM to "EPERM",
      OsConstants.EROFS to "EROFS",
      OsConstants.EEXIST to "EEXIST",
      OsConstants.ENOENT to "ENOENT",
      OsConstants.EXDEV to "EXDEV",
      OsConstants.EOPNOTSUPP to "EOPNOTSUPP",
      OsConstants.EIO to "EIO",
      OsConstants.ENOTDIR to "ENOTDIR"
    )
    expected.forEach { (errno, name) ->
      val cause = IOException("private path and message", ErrnoException("operation", errno))
      val error = StorageFailure.wrap(StorageStage.PROGRESS_SAVE, cause)
      assertEquals("E_STORAGE_STAGE_ERRNO:PROGRESS_SAVE:$name", error.errorCode)
      assertEquals("Unable to complete a device storage operation", error.message)
    }
  }

  @Test fun usesUnknownForUnclassifiedAndOverlongCauseChains() {
    val unclassified = StorageFailure.wrap(StorageStage.WITNESS_COPY, IOException("private"))
    assertEquals("E_STORAGE_STAGE_ERRNO:WITNESS_COPY:UNKNOWN", unclassified.errorCode)

    var cause: Throwable = ErrnoException("operation", OsConstants.ENOSPC)
    repeat(17) { cause = IOException("wrapper", cause) }
    val tooDeep = StorageFailure.wrap(StorageStage.JOURNAL_READ, cause as Exception)
    assertEquals("E_STORAGE_STAGE_ERRNO:JOURNAL_READ:UNKNOWN", tooDeep.errorCode)
  }

  @Test fun stageAndFixedErrnoAreClosedAndDiagnosticDoesNotIncludeCauseText() {
    val error = StorageFailure.wrap(
      StorageStage.PUBLICATION_LINK,
      IOException("https://secret.example/video/private-id")
    )
    assertEquals("E_STORAGE_STAGE_ERRNO:PUBLICATION_LINK:UNKNOWN", error.errorCode)
    assertEquals("Unable to complete a device storage operation", error.message)
    assertEquals(
      "E_STORAGE_STAGE_ERRNO:STORE_INIT:UNKNOWN",
      StorageFailure.known(StorageStage.STORE_INIT, "ENOKEY").errorCode
    )
  }
}