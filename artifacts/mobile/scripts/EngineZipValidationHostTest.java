package com.diwan.downloader;

import java.io.File;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.Comparator;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

/** Runs the production streaming parser, not an Android device or the audio engine. */
public final class EngineZipValidationHostTest {
  private static final String VERSION = "2026.08.19";
  private static final String HASH = "1fa6733c37ea6fb51c99ad8fe785e7b7e5f3246c9b980230329d4fb72ed8d4d6";
  private static final byte[] PREFIX = "#!/usr/bin/env python3\n".getBytes(StandardCharsets.US_ASCII);
  private static int checks;

  private static void require(boolean value, String label) {
    if (!value) throw new AssertionError(label);
    checks++;
  }

  private static boolean accepts(Path file, String version) throws IOException {
    return EngineZipValidation.isValid(file.toFile(), version, () -> {});
  }

  private static void rejects(Path file, String label) throws IOException {
    try {
      require(!accepts(file, VERSION), label);
    } catch (IOException expected) {
      checks++;
    }
  }

  private static void entry(ZipOutputStream zip, String name, byte[] bytes) throws IOException {
    zip.putNextEntry(new ZipEntry(name));
    zip.write(bytes);
    zip.closeEntry();
  }

  private static byte[] text(String value) {
    return value.getBytes(StandardCharsets.UTF_8);
  }

  private static void requiredEntries(ZipOutputStream zip, String missing, String version) throws IOException {
    if (!"__main__.py".equals(missing)) entry(zip, "__main__.py", text("print('test')\n"));
    if (!"yt_dlp/version.py".equals(missing)) {
      entry(zip, "yt_dlp/version.py", text("__version__ = '" + version + "'\n"));
    }
    if (!"yt_dlp_ejs/yt/solver/core.min.js".equals(missing)) {
      entry(zip, "yt_dlp_ejs/yt/solver/core.min.js", text("test"));
    }
  }

  public static void main(String[] args) throws Exception {
    Path asset = Path.of(args[0]);
    byte[] bundled = Files.readAllBytes(asset);
    StringBuilder hex = new StringBuilder();
    for (byte b : MessageDigest.getInstance("SHA-256").digest(bundled)) {
      hex.append(String.format("%02x", b & 0xff));
    }
    require(bundled.length == 3_072_469 && HASH.contentEquals(hex), "official package pin");
    for (int i = 0; i < PREFIX.length; i++) require(bundled[i] == PREFIX[i], "zipapp launcher prefix");

    // Reproduce the explicit Android 15 ZipFile offset-zero check:
    // https://android.googlesource.com/platform/libcore/+/refs/tags/android-15.0.0_r1/ojluni/src/main/java/java/util/zip/ZipFile.java
    int magic = ByteBuffer.wrap(bundled, 0, 4).order(ByteOrder.LITTLE_ENDIAN).getInt();
    require(magic != 0x04034b50 && magic != 0x06054b50, "Android ZipFile rejects the official zipapp header");
    require(accepts(asset, VERSION), "production parser accepts the exact official prefixed zipapp");
    require(!accepts(asset, "1900.01.01"), "wrong expected version is rejected");

    final class Cancelled extends RuntimeException {}
    try {
      EngineZipValidation.isValid(asset.toFile(), VERSION, () -> { throw new Cancelled(); });
      throw new AssertionError("cancellation must propagate");
    } catch (Cancelled expected) {
      checks++;
    }

    Path root = Files.createTempDirectory("diwan-zip-cases-");
    try {
      Path plain = root.resolve("plain.zip");
      Files.write(plain, java.util.Arrays.copyOfRange(bundled, PREFIX.length, bundled.length));
      require(accepts(plain, VERSION), "plain ZIP without launcher also accepted");

      for (String missing : new String[]{"__main__.py", "yt_dlp/version.py", "yt_dlp_ejs/yt/solver/core.min.js"}) {
        Path file = root.resolve("missing-" + checks + ".zip");
        try (ZipOutputStream zip = new ZipOutputStream(Files.newOutputStream(file))) {
          requiredEntries(zip, missing, VERSION);
        }
        rejects(file, "missing component " + missing);
      }

      Path wrongVersion = root.resolve("wrong-version.zip");
      try (ZipOutputStream zip = new ZipOutputStream(Files.newOutputStream(wrongVersion))) {
        requiredEntries(zip, null, "1900.01.01");
      }
      rejects(wrongVersion, "embedded version mismatch");

      Path malformed = root.resolve("malformed.zip");
      Files.write(malformed, new byte[]{0x50, 0x4b, 0x03, 0x04, 1, 2, 3});
      rejects(malformed, "truncated ZIP");

      Path largeVersion = root.resolve("oversized-version.zip");
      try (ZipOutputStream zip = new ZipOutputStream(Files.newOutputStream(largeVersion))) {
        entry(zip, "yt_dlp/version.py", new byte[65_537]);
        requiredEntries(zip, "yt_dlp/version.py", VERSION);
      }
      rejects(largeVersion, "bounded version source");

      Path manyEntries = root.resolve("many-entries.zip");
      try (ZipOutputStream zip = new ZipOutputStream(Files.newOutputStream(manyEntries))) {
        for (int i = 0; i < 2_049; i++) entry(zip, "padding/" + i, new byte[0]);
        requiredEntries(zip, null, VERSION);
      }
      rejects(manyEntries, "bounded entry count");

      Path inflated = root.resolve("inflated.zip");
      try (ZipOutputStream zip = new ZipOutputStream(Files.newOutputStream(inflated))) {
        zip.putNextEntry(new ZipEntry("padding"));
        byte[] block = new byte[16_384];
        for (int i = 0; i < 4_097; i++) zip.write(block);
        zip.closeEntry();
        requiredEntries(zip, null, VERSION);
      }
      rejects(inflated, "bounded total uncompressed bytes");
    } finally {
      try (var paths = Files.walk(root)) {
        for (Path path : paths.sorted(Comparator.reverseOrder()).toList()) Files.delete(path);
      }
    }
    System.out.println("Engine ZIP host checks passed: " + checks);
    System.out.println("Android header rejection reproduced; production parser accepts unchanged authenticated zipapp.");
    System.out.println("These are host parser checks, not Android lifecycle or audio-download tests.");
  }
}