import type { Poem, Verse } from './types';

export type PoemExportFormat = 'lrc' | 'srt' | 'json';

const isValidAlignment = (verse: Verse) => {
  const alignment = verse.alignment;
  return (
    !!alignment &&
    Number.isFinite(alignment.startMs) &&
    Number.isFinite(alignment.endMs) &&
    alignment.startMs >= 0 &&
    alignment.endMs >= alignment.startMs
  );
};

export function hasSynchronizedAudio(poem: Poem): boolean {
  return !!poem.recording && poem.verses.some(isValidAlignment);
}

function alignedVerses(poem: Poem): Verse[] {
  return poem.verses
    .filter(isValidAlignment)
    .map((verse, index) => ({ verse, index }))
    .sort(
      (a, b) =>
        a.verse.alignment!.startMs - b.verse.alignment!.startMs ||
        a.verse.orderIndex - b.verse.orderIndex ||
        a.index - b.index,
    )
    .map(({ verse }) => verse);
}

export function formatLrcTimestamp(milliseconds: number): string {
  const ms = Math.floor(milliseconds);
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const hundredths = Math.floor((ms % 1000) / 10);
  return `[${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(hundredths).padStart(2, '0')}]`;
}

export function formatSrtTimestamp(milliseconds: number): string {
  const ms = Math.floor(milliseconds);
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const remainder = ms % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(remainder).padStart(3, '0')}`;
}

// LRC and SRT are line/block-oriented formats, so normalize untrusted text to
// one safe line and prevent verse text from being mistaken for an LRC tag.
function formatLine(text: string, protectLrcTag = false): string {
  const singleLine = text
    .replace(/[\r\n\u2028\u2029]+/g, ' ')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return protectLrcTag ? singleLine.replace(/^\[/, '［') : singleLine;
}

function formatMetadata(value: string): string {
  return formatLine(value).replace(/\[/g, '［').replace(/\]/g, '］');
}

export function buildLrc(poem: Poem): string {
  const lines = [
    `[ti:${formatMetadata(poem.title)}]`,
    `[ar:${formatMetadata(poem.poetName)}]`,
    '[al:ديوان الشعر العربي]',
    '[by:Diwan]',
    '',
    ...alignedVerses(poem).map(
      (verse) => `${formatLrcTimestamp(verse.alignment!.startMs)}${formatLine(verse.text, true)}`,
    ),
  ];
  const unaligned = poem.verses.filter((verse) => !isValidAlignment(verse));
  if (unaligned.length) {
    lines.push('', ...unaligned.map((verse) => `# [غير محاذى] ${formatLine(verse.text, true)}`));
  }
  return `${lines.join('\n')}\n`;
}

export function buildSrt(poem: Poem): string {
  return alignedVerses(poem)
    .map(
      (verse, index) =>
        `${index + 1}\n${formatSrtTimestamp(verse.alignment!.startMs)} --> ${formatSrtTimestamp(verse.alignment!.endMs)}\n${formatLine(verse.text)}`,
    )
    .join('\n\n') + (hasSynchronizedAudio(poem) ? '\n' : '');
}

export function buildPoemJson(poem: Poem): string {
  return `${JSON.stringify(
    {
      schema_version: '1.0',
      generator: 'Diwan Mobile',
      exported_at: new Date().toISOString(),
      poem,
    },
    null,
    2,
  )}\n`;
}

export function sanitizePoemFilename(title: string): string {
  const safe = title
    .normalize('NFC')
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, 80);
  return safe || 'poem';
}

function getExportDetails(poem: Poem, format: PoemExportFormat) {
  const title = sanitizePoemFilename(poem.title);
  switch (format) {
    case 'lrc':
      return { filename: `${title}.lrc`, mimeType: 'application/x-lrc', content: buildLrc(poem), uti: 'public.plain-text' };
    case 'srt':
      return { filename: `${title}.srt`, mimeType: 'application/x-subrip', content: buildSrt(poem), uti: 'public.plain-text' };
    case 'json':
      return { filename: `${title}.json`, mimeType: 'application/json', content: buildPoemJson(poem), uti: 'public.json' };
  }
}

export async function sharePoemExport(poem: Poem, format: PoemExportFormat): Promise<void> {
  if (format !== 'json' && !hasSynchronizedAudio(poem)) {
    throw new Error('لا يمكن تصدير التوقيت دون تسجيل صوتي وأبيات متزامنة.');
  }
  const { filename, mimeType, content, uti } = getExportDetails(poem, format);

  if (typeof document !== 'undefined' && typeof URL !== 'undefined' && typeof Blob !== 'undefined') {
    const blob = new Blob([content], { type: `${mimeType};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return;
  }

  const FileSystem = await import('expo-file-system/legacy');
  const Sharing = await import('expo-sharing');
  if (!FileSystem.cacheDirectory) {
    throw new Error('مساحة الملفات المؤقتة غير متاحة على هذا الجهاز.');
  }
  const uri = `${FileSystem.cacheDirectory}${Date.now()}-${filename}`;
  await FileSystem.writeAsStringAsync(uri, content, {
    encoding: FileSystem.EncodingType.UTF8,
  });
  if (!(await Sharing.isAvailableAsync())) {
    throw new Error('مشاركة الملفات غير متاحة على هذا الجهاز.');
  }
  await Sharing.shareAsync(uri, {
    mimeType,
    dialogTitle: `تصدير ${poem.title}`,
    UTI: uti,
  });
}