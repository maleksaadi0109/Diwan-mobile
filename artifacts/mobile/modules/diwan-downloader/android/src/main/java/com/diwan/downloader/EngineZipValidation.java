package com.diwan.downloader;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.PushbackInputStream;
import java.nio.charset.StandardCharsets;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/** Bounded, non-extracting validation for the pinned Python zipapp. */
public final class EngineZipValidation {
  private static final byte[] PYTHON_SHEBANG =
      "#!/usr/bin/env python3\n".getBytes(StandardCharsets.US_ASCII);
  private static final int ENTRY_LIMIT = 2048;
  private static final long TOTAL_UNCOMPRESSED_LIMIT = 64L * 1024 * 1024;
  private static final long VERSION_ENTRY_LIMIT = 64L * 1024;
  private static final int BUFFER_SIZE = 8 * 1024;
  private static final Pattern VERSION_PATTERN =
      Pattern.compile("__version__\\s*=\\s*(['\"])([^'\"]+)\\1");

  private EngineZipValidation() {}

  public static boolean isValid(
      File file, String expectedVersion, Runnable cancellationCheck) throws IOException {
    cancellationCheck.run();
    try (PushbackInputStream input =
        new PushbackInputStream(new FileInputStream(file), PYTHON_SHEBANG.length)) {
      byte[] probe = new byte[PYTHON_SHEBANG.length];
      int probeLength = 0;
      while (probeLength < probe.length) {
        cancellationCheck.run();
        int count = input.read(probe, probeLength, probe.length - probeLength);
        if (count < 0) break;
        if (count == 0) continue;
        probeLength += count;
      }

      boolean prefixed =
          probeLength == PYTHON_SHEBANG.length && matchesShebang(probe);
      if (!prefixed) {
        if (probeLength == 0) return false;
        input.unread(probe, 0, probeLength);
        byte[] magic = new byte[2];
        int magicLength = 0;
        while (magicLength < magic.length) {
          cancellationCheck.run();
          int count = input.read(magic, magicLength, magic.length - magicLength);
          if (count < 0) break;
          if (count == 0) continue;
          magicLength += count;
        }
        if (magicLength < 2 || magic[0] != 'P' || magic[1] != 'K') return false;
        input.unread(magic, 0, magicLength);
      }

      return validateEntries(input, expectedVersion, cancellationCheck);
    }
  }

  private static boolean matchesShebang(byte[] probe) {
    for (int index = 0; index < PYTHON_SHEBANG.length; index++) {
      if (probe[index] != PYTHON_SHEBANG[index]) return false;
    }
    return true;
  }

  private static boolean validateEntries(
      PushbackInputStream input, String expectedVersion, Runnable cancellationCheck)
      throws IOException {
    boolean hasMain = false;
    boolean hasVersion = false;
    boolean hasEjs = false;
    long totalUncompressed = 0;
    int entryCount = 0;
    byte[] buffer = new byte[BUFFER_SIZE];
    ByteArrayOutputStream versionSource = new ByteArrayOutputStream();

    try (ZipInputStream zip = new ZipInputStream(input)) {
      while (true) {
        cancellationCheck.run();
        ZipEntry entry = zip.getNextEntry();
        if (entry == null) break;
        entryCount++;
        if (entryCount > ENTRY_LIMIT) return false;

        boolean mainEntry = "__main__.py".equals(entry.getName());
        boolean versionEntry = "yt_dlp/version.py".equals(entry.getName());
        boolean ejsEntry =
            "yt_dlp_ejs/yt/solver/core.min.js".equals(entry.getName());
        long entryBytes = 0;
        while (true) {
          cancellationCheck.run();
          int count = zip.read(buffer, 0, buffer.length);
          if (count < 0) break;
          if (count == 0) continue;
          if (count > TOTAL_UNCOMPRESSED_LIMIT - totalUncompressed) return false;
          totalUncompressed += count;
          entryBytes += count;
          if (versionEntry) {
            if (entryBytes > VERSION_ENTRY_LIMIT) return false;
            versionSource.write(buffer, 0, count);
          }
        }
        zip.closeEntry();

        if (!entry.isDirectory()) {
          if (mainEntry && entryBytes > 0) hasMain = true;
          if (versionEntry && entryBytes > 0) hasVersion = true;
          if (ejsEntry && entryBytes > 0) hasEjs = true;
        }
      }
    }

    if (!hasMain || !hasVersion || !hasEjs) return false;
    Matcher versionMatcher =
        VERSION_PATTERN.matcher(new String(versionSource.toByteArray(), StandardCharsets.UTF_8));
    return versionMatcher.find() && expectedVersion.equals(versionMatcher.group(2));
  }
}