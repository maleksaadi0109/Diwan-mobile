import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as FileSystem from 'expo-file-system/legacy';
import type { Playlist, Poem, Recording } from './types';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createPoemRemoval, withoutPoemIds } from './poemDeletion';

const mocks = vi.hoisted(() => ({
  files: new Map<string, string>(),
  binary: new Map<string, { bytes: Uint8Array; size: number }>(),
  storage: new Map<string, string>(),
  deleted: [] as string[],
  deleteFailures: new Set<string>(),
  pickedUri: '',
  failPlaylistWrite: false,
  failPoemWrite: false,
}));

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    multiGet: vi.fn(async (keys: string[]) => keys.map((key) => [key, mocks.storage.get(key) ?? null])),
    setItem: vi.fn(async (key: string, value: string) => {
      if (key === 'diwan.mobile.playlists.v1' && mocks.failPlaylistWrite) throw new Error('Playlist write failed');
      if (key === 'diwan.mobile.poems.v1' && mocks.failPoemWrite) throw new Error('Poem write failed');
      mocks.storage.set(key, value);
    }),
  },
}));
vi.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///documents/',
  cacheDirectory: 'file:///cache/',
  EncodingType: { Base64: 'base64', UTF8: 'utf8' },
  getInfoAsync: vi.fn(async (uri: string) => ({
    exists: mocks.files.has(uri) || mocks.binary.has(uri),
    size: mocks.binary.get(uri)?.size ?? mocks.files.get(uri)?.length ?? 0,
  })),
  makeDirectoryAsync: vi.fn(async () => undefined),
  writeAsStringAsync: vi.fn(async (uri: string, data: string) => {
    mocks.files.set(uri, data);
  }),
  readAsStringAsync: vi.fn(async (uri: string) => {
    if (!mocks.files.has(uri)) throw new Error('File missing');
    return mocks.files.get(uri)!;
  }),
  deleteAsync: vi.fn(async (uri: string) => {
    mocks.deleted.push(uri);
    if (mocks.deleteFailures.has(uri)) throw new Error('Delete failed');
    mocks.files.delete(uri);
    mocks.binary.delete(uri);
  }),
}));

vi.mock('expo-file-system', () => ({
  FileMode: { ReadOnly: 'r', WriteOnly: 'w' },
  File: class {
    uri: string;
    constructor(uri: string) { this.uri = uri; }
    get size() { return mocks.binary.get(this.uri)?.size ?? 0; }
    create() {
      if (mocks.binary.has(this.uri) || mocks.files.has(this.uri)) throw new Error('already exists');
      mocks.binary.set(this.uri, { bytes: new Uint8Array(0), size: 0 });
    }
    open(mode: string) {
      const uri = this.uri;
      if (!mocks.binary.has(uri)) throw new Error('File missing');
      let position = 0;
      return {
        get size() { return mocks.binary.get(uri)!.size; },
        get offset() { return position; },
        set offset(value: number) { position = value; },
        readBytes(length: number) {
          const file = mocks.binary.get(uri)!;
          const result = file.bytes.slice(position, Math.min(position + length, file.size));
          position += result.length;
          return result;
        },
        writeBytes(bytes: Uint8Array) {
          if (mode !== 'w') throw new Error('read only');
          const file = mocks.binary.get(uri)!;
          const end = position + bytes.length;
          if (end > file.bytes.length) {
            const next = new Uint8Array(Math.max(end, file.bytes.length * 2, 1024));
            next.set(file.bytes.subarray(0, file.size));
            file.bytes = next;
          }
          file.bytes.set(bytes, position);
          file.size = Math.max(file.size, end);
          position = end;
        },
        close() {},
      };
    }
  },
}));
vi.mock('expo-document-picker', () => ({
  getDocumentAsync: vi.fn(async () => ({
    canceled: false,
    assets: [{ uri: mocks.pickedUri, name: 'library.diwan', size: mocks.binary.get(mocks.pickedUri)?.size }],
  })),
}));

import {
  assertBackupPlaylistReferences, createBackupArchive, createBackupJson, parseBackupJson,
  pickBackup, remapBackupPlaylists, restoreBackupAudio, restoreBackupMerge, type MobileBackup,
} from './backup';

const local = (id: string): Recording => ({
  id, audioUrl: `file:///documents/recording-audio/${id}.mp3`, durationMs: 900,
});
const remote = (id: string): Recording => ({
  ...local(id), serverAudioUrl: `https://example.com/${id}.mp3`,
});
const poem = (id: string, recording: Recording): Poem => ({
  id, title: 'قصيدة', poetName: 'شاعر', createdAt: 1, recording,
  verses: [{ id: 'v1', orderIndex: 0, text: 'بيت', alignment: { startMs: 10, endMs: 20, confidence: 1 } }],
});
const backup = (version: 1 | 2, poems: Poem[], audioFiles?: MobileBackup['audioFiles']): MobileBackup => ({
  format: 'diwan-mobile-backup', version, createdAt: '2026-09-30T00:00:00Z',
  poems, playlists: [], settings: { fontSize: 24 }, ...(audioFiles === undefined ? {} : { audioFiles }),
});
const parse = (value: MobileBackup) => parseBackupJson(JSON.stringify(value));

beforeEach(() => {
  mocks.files.clear();
  mocks.binary.clear();
  mocks.storage.clear();
  mocks.deleted.length = 0;
  mocks.deleteFailures.clear();
  mocks.pickedUri = '';
  mocks.failPlaylistWrite = false;
  mocks.failPoemWrite = false;
  vi.clearAllMocks();
});

describe('restore write failures', () => {
  const poemsKey = 'diwan.mobile.poems.v1';
  const playlistsKey = 'diwan.mobile.playlists.v1';

  function storageWriters() {
    const savePoem = async (item: Poem) => {
      const current = JSON.parse(mocks.storage.get(poemsKey)!) as Poem[];
      if (current.some((poem) => poem.id === item.id)) return { inserted: false, poemId: item.id };
      await AsyncStorage.setItem(poemsKey, JSON.stringify([item, ...current]));
      return { inserted: true, poemId: item.id };
    };
    const removePoems = async (ids: string[]) => {
      const current = JSON.parse(mocks.storage.get(poemsKey)!) as Poem[];
      await AsyncStorage.setItem(poemsKey, JSON.stringify(current.filter((poem) => !ids.includes(poem.id))));
    };
    const mergePlaylists = async (incoming: Playlist[]) => {
      const current = JSON.parse(mocks.storage.get(playlistsKey)!) as Playlist[];
      await AsyncStorage.setItem(playlistsKey, JSON.stringify([...incoming, ...current]));
      return { added: incoming.length, skipped: 0 };
    };
    return { savePoem, removePoems, mergePlaylists };
  }

  it('restores the original library and audio if the playlist storage write fails', async () => {
    const original = poem('existing', local('existing'));
    const first = poem('new-one', local('first'));
    const second = poem('new-two', local('second'));
    const existingLists: Playlist[] = [{ id: 'existing-list', name: 'محفوظة', poemIds: ['existing'], createdAt: 1 }];
    const incoming: Playlist = { id: 'new-list', name: 'جديدة', poemIds: ['new-one', 'new-two'], createdAt: 1 };
    const originalPoems = JSON.stringify([original]);
    const originalPlaylists = JSON.stringify(existingLists);
    mocks.storage.set(poemsKey, originalPoems);
    mocks.storage.set(playlistsKey, originalPlaylists);
    mocks.files.set(original.recording!.audioUrl, 'original audio');
    mocks.failPlaylistWrite = true;
    const parsed = parse({
      ...backup(2, [first, second], [
        { poemId: first.id, recordingId: 'first', base64: 'YQ==' },
        { poemId: second.id, recordingId: 'second', base64: 'Yg==' },
      ]),
      playlists: [incoming],
    });
    const writers = storageWriters();
    await expect(restoreBackupMerge(parsed, ['existing'], writers.savePoem, writers.removePoems, writers.mergePlaylists))
      .rejects.toThrow('Playlist write failed');
    expect(mocks.storage.get(poemsKey)).toBe(originalPoems);
    expect(mocks.storage.get(playlistsKey)).toBe(originalPlaylists);
    expect(mocks.files.get(original.recording!.audioUrl)).toBe('original audio');
    expect(mocks.files.has(first.recording!.audioUrl)).toBe(false);
    expect(mocks.files.has(second.recording!.audioUrl)).toBe(false);
    mocks.failPlaylistWrite = false;
    await expect(restoreBackupMerge(parsed, ['existing'], writers.savePoem, writers.removePoems, writers.mergePlaylists))
      .resolves.toEqual({ added: 1, skipped: 0 });
    expect((JSON.parse(mocks.storage.get(poemsKey)!) as Poem[]).map((item) => item.id))
      .toEqual(['new-two', 'new-one', 'existing']);
    expect((JSON.parse(mocks.storage.get(playlistsKey)!) as Playlist[])[0].poemIds)
      .toEqual(['new-one', 'new-two']);
  });

  it('undoes previously saved poems and audio when a later poem write fails', async () => {
    const first = poem('one', local('one'));
    const second = poem('two', local('two'));
    mocks.storage.set(poemsKey, '[]');
    mocks.storage.set(playlistsKey, '[]');
    const writers = storageWriters();
    const savePoem = async (item: Poem) => {
      if (item.id === 'two') mocks.failPoemWrite = true;
      return writers.savePoem(item);
    };
    const removePoems = async (ids: string[]) => {
      mocks.failPoemWrite = false;
      return writers.removePoems(ids);
    };
    const parsed = parse(backup(2, [first, second], [
      { poemId: 'one', recordingId: 'one', base64: 'YQ==' },
      { poemId: 'two', recordingId: 'two', base64: 'Yg==' },
    ]));
    await expect(restoreBackupMerge(parsed, [], savePoem, removePoems, writers.mergePlaylists))
      .rejects.toThrow('Poem write failed');
    expect(mocks.storage.get(poemsKey)).toBe('[]');
    expect(mocks.storage.get(playlistsKey)).toBe('[]');
    expect(mocks.files.size).toBe(0);
  });

  it('reports when rollback itself cannot write and preserves audio still used by inserted poems', async () => {
    const added = poem('added', local('added'));
    mocks.storage.set(poemsKey, '[]');
    mocks.storage.set(playlistsKey, '[]');
    const writers = storageWriters();
    const removePoems = async (_ids: string[]) => {
      mocks.failPoemWrite = true;
      return writers.removePoems(_ids);
    };
    mocks.failPlaylistWrite = true;
    const parsed = parse(backup(2, [added], [
      { poemId: added.id, recordingId: 'added', base64: 'YQ==' },
    ]));
    await expect(restoreBackupMerge(parsed, [], writers.savePoem, removePoems, writers.mergePlaylists))
      .rejects.toThrow('تعذر التراجع عن القصائد المضافة');
    expect((JSON.parse(mocks.storage.get(poemsKey)!) as Poem[])[0].id).toBe('added');
    expect(mocks.files.has(added.recording!.audioUrl)).toBe(true);
    expect(mocks.storage.get(playlistsKey)).toBe('[]');
  });
});

describe('library poem deletion and backup', () => {
  const poemsKey = 'diwan.mobile.poems.v1';
  const playlistsKey = 'diwan.mobile.playlists.v1';
  const poemWithoutAudio = (id: string): Poem => ({
    id, title: id, poetName: 'شاعر', verses: [], createdAt: 1,
  });

  function savedDeletion() {
    const removeFromPlaylists = async (ids: string[]) => {
      const current = JSON.parse(mocks.storage.get(playlistsKey)!) as Playlist[];
      mocks.storage.set(playlistsKey, JSON.stringify(withoutPoemIds(current, new Set(ids))));
    };
    const updatePoems = async (updater: (current: Poem[]) => Poem[]) => {
      const current = JSON.parse(mocks.storage.get(poemsKey)!) as Poem[];
      mocks.storage.set(poemsKey, JSON.stringify(updater(current)));
    };
    return createPoemRemoval(removeFromPlaylists, updatePoems);
  }

  it('exports after deleting one poem, preserving playlist order and other details', async () => {
    mocks.storage.set(poemsKey, JSON.stringify(['a', 'b', 'c'].map(poemWithoutAudio)));
    const lists: Playlist[] = [
      { id: 'first', name: 'المفضلة', createdAt: 12, poemIds: ['c', 'b', 'a'] },
      { id: 'second', name: 'أخرى', createdAt: 13, poemIds: ['b', 'c'] },
    ];
    mocks.storage.set(playlistsKey, JSON.stringify(lists));

    await savedDeletion().removePoem('b');

    const exported = parseBackupJson(await createBackupJson());
    expect(exported.poems.map((p) => p.id)).toEqual(['a', 'c']);
    expect(exported.playlists).toEqual([
      { ...lists[0], poemIds: ['c', 'a'] },
      { ...lists[1], poemIds: ['c'] },
    ]);
  });

  it('exports an archive after bulk deletion across playlists', async () => {
    mocks.storage.set(poemsKey, JSON.stringify(['a', 'b', 'c', 'd'].map(poemWithoutAudio)));
    const lists: Playlist[] = [
      { id: 'first', name: 'الأولى', createdAt: 12, poemIds: ['d', 'a', 'c', 'b'] },
      { id: 'second', name: 'الثانية', createdAt: 13, poemIds: ['a', 'd'] },
    ];
    mocks.storage.set(playlistsKey, JSON.stringify(lists));

    await savedDeletion().removePoems(['a', 'c']);

    expect(JSON.parse(mocks.storage.get(poemsKey)!)).toEqual(['b', 'd'].map(poemWithoutAudio));
    expect(JSON.parse(mocks.storage.get(playlistsKey)!)).toEqual([
      { ...lists[0], poemIds: ['d', 'b'] },
      { ...lists[1], poemIds: ['d'] },
    ]);
    await expect(createBackupArchive()).resolves.toMatch(/\.diwan$/);
  });

  it('does not delete a poem when playlist cleanup cannot be saved', async () => {
    const poems = [poemWithoutAudio('a')];
    const playlists: Playlist[] = [
      { id: 'first', name: 'الأولى', createdAt: 12, poemIds: ['a'] },
    ];
    const updatePoems = vi.fn(async () => undefined);
    const removal = createPoemRemoval(async () => { throw new Error('Save failed'); }, updatePoems);
    await expect(removal.removePoem('a')).rejects.toThrow('Save failed');
    expect(updatePoems).not.toHaveBeenCalled();
    mocks.storage.set(poemsKey, JSON.stringify(poems));
    mocks.storage.set(playlistsKey, JSON.stringify(playlists));
    expect(parseBackupJson(await createBackupJson()).playlists).toEqual(playlists);
  });
});

describe('backup compatibility and audio restore', () => {
  it('exports and imports an archive with audio exceeding the legacy 100 MB limit', async () => {
    const original = poem('big', local('large'));
    const audio = new Uint8Array(100 * 1024 * 1024 + 1);
    audio.fill(97);
    mocks.binary.set(original.recording!.audioUrl, { bytes: audio, size: audio.length });
    mocks.storage.set('diwan.mobile.poems.v1', JSON.stringify([original]));
    const uri = await createBackupArchive();
    expect(mocks.binary.get(uri)!.size).toBeGreaterThan(100 * 1024 * 1024);
    mocks.binary.delete(original.recording!.audioUrl);
    mocks.pickedUri = uri;
    const picked = await pickBackup();
    if (!picked || picked.kind !== 'archive') throw new Error('Expected archive');
    const [restored] = await restoreBackupAudio(picked.backup, new Set(), picked);
    expect(restored.verses).toEqual(original.verses);
    const output = mocks.binary.get(restored.recording!.audioUrl)!;
    expect(output.size).toBe(audio.length);
    expect(output.bytes[0]).toBe(97);
    expect(output.bytes[output.size - 1]).toBe(97);
  }, 120_000);

  it('rejects corrupted archive audio before changing any saved recording', async () => {
    const original = poem('small', local('small'));
    mocks.binary.set(original.recording!.audioUrl, { bytes: new Uint8Array([1, 2, 3]), size: 3 });
    mocks.storage.set('diwan.mobile.poems.v1', JSON.stringify([original]));
    const uri = await createBackupArchive();
    const archive = mocks.binary.get(uri)!;
    archive.bytes[archive.size - 1] ^= 1;
    mocks.pickedUri = uri;
    await expect(pickBackup()).rejects.toThrow('تالف');
    expect(mocks.binary.has(original.recording!.audioUrl)).toBe(true);
  });

  it('restores v1 legacy remote audio without bundling or changing verse timing', async () => {
    const legacy = poem('old', { id: 'legacy', audioUrl: 'https://example.com/legacy.mp3', durationMs: 900 });
    const parsed = parse(backup(1, [legacy]));
    expect((await restoreBackupAudio(parsed, new Set()))[0]).toMatchObject({
      recording: legacy.recording, verses: legacy.verses,
    });
    expect(mocks.files.size).toBe(0);
  });

  it('exports and restores v2 audio, preserving each recording and its verse alignments', async () => {
    const first = local('first');
    const second = local('second');
    const original: Poem = {
      ...poem('new', first), recordings: [first, second], selectedRecordingId: 'second',
      recording: second,
      verses: [{
        id: 'v1', orderIndex: 0, text: 'بيت',
        alignment: { startMs: 50, endMs: 70, confidence: 1 },
        recordingAlignments: { first: { startMs: 10, endMs: 20, confidence: 1 } },
      }],
    };
    mocks.files.set(first.audioUrl, 'YQ==');
    mocks.files.set(second.audioUrl, 'Yg==');
    mocks.storage.set('diwan.mobile.poems.v1', JSON.stringify([original]));
    const exported = parseBackupJson(await createBackupJson());
    expect(exported.version).toBe(2);
    expect(exported.audioFiles).toEqual([
      { poemId: 'new', recordingId: 'first', base64: 'YQ==' },
      { poemId: 'new', recordingId: 'second', base64: 'Yg==' },
    ]);
    mocks.files.clear();
    const [restored] = await restoreBackupAudio(exported, new Set());
    expect(restored.recordings).toEqual([first, second]);
    expect(restored.recording).toEqual(second);
    expect(restored.verses).toEqual(original.verses);
    expect(mocks.files.get(first.audioUrl)).toBe('YQ==');
    expect(mocks.files.get(second.audioUrl)).toBe('Yg==');
  });

  it('skips an existing poem and never replaces its colliding audio file', async () => {
    const existing = local('shared');
    mocks.files.set(existing.audioUrl, 'original');
    const parsed = parse(backup(2, [poem('existing', existing)], [
      { poemId: 'existing', recordingId: 'shared', base64: 'YQ==' },
    ]));
    expect(await restoreBackupAudio(parsed, new Set(['existing']))).toEqual([]);
    expect(mocks.files.get(existing.audioUrl)).toBe('original');
  });

  it('rejects a collision for a new poem without touching the existing file', async () => {
    const recording = local('shared');
    mocks.files.set(recording.audioUrl, 'original');
    const parsed = parse(backup(2, [poem('new', recording)], [
      { poemId: 'new', recordingId: 'shared', base64: 'YQ==' },
    ]));
    await expect(restoreBackupAudio(parsed, new Set())).rejects.toThrow('already exists');
    expect(mocks.files.get(recording.audioUrl)).toBe('original');
    expect(mocks.deleted).toEqual([]);
  });

  it('cleans up only files created during a partially failed restore', async () => {
    const first = local('first');
    const collision = local('collision');
    mocks.files.set(collision.audioUrl, 'original');
    const parsed = parse(backup(2, [poem('a', first), poem('b', collision)], [
      { poemId: 'a', recordingId: 'first', base64: 'YQ==' },
      { poemId: 'b', recordingId: 'collision', base64: 'Yg==' },
    ]));
    await expect(restoreBackupAudio(parsed, new Set())).rejects.toThrow('already exists');
    expect(mocks.deleted).toEqual([first.audioUrl]);
    expect(mocks.files.has(first.audioUrl)).toBe(false);
    expect(mocks.files.get(collision.audioUrl)).toBe('original');
  });

  it('reports failed cleanup after extraction fails without deleting a pre-existing file', async () => {
    const first = local('first');
    const collision = local('collision');
    mocks.files.set(collision.audioUrl, 'original');
    mocks.deleteFailures.add(first.audioUrl);
    const parsed = parse(backup(2, [poem('a', first), poem('b', collision)], [
      { poemId: 'a', recordingId: first.id, base64: 'YQ==' },
      { poemId: 'b', recordingId: collision.id, base64: 'Yg==' },
    ]));

    await expect(restoreBackupAudio(parsed, new Set())).rejects.toThrow(
      new RegExp(`already exists[\\s\\S]*تعذر حذف ملفات الصوت الجديدة[\\s\\S]*${first.id}`),
    );
    expect(mocks.deleted).toEqual([first.audioUrl]);
    expect(mocks.files.get(first.audioUrl)).toBe('YQ==');
    expect(mocks.files.get(collision.audioUrl)).toBe('original');
  });

  it('reports both a failed audio write and failed partial-file cleanup', async () => {
    const partial = local('partial');
    const existing = local('existing');
    mocks.files.set(existing.audioUrl, 'original');
    mocks.deleteFailures.add(partial.audioUrl);
    vi.mocked(FileSystem.writeAsStringAsync).mockImplementationOnce(async (uri) => {
      mocks.files.set(uri, 'partial data');
      throw new Error('Write failed');
    });
    const parsed = parse(backup(2, [poem('new', partial)], [
      { poemId: 'new', recordingId: partial.id, base64: 'YQ==' },
    ]));

    await expect(restoreBackupAudio(parsed, new Set())).rejects.toThrow(
      `Write failed\nتعذر حذف ملف الصوت الجديد ${partial.audioUrl} بعد فشل كتابته: Delete failed`,
    );
    expect(mocks.deleted).toEqual([partial.audioUrl]);
    expect(mocks.files.get(partial.audioUrl)).toBe('partial data');
    expect(mocks.files.get(existing.audioUrl)).toBe('original');
  });

  it('removes only unsaved audio when saving a restored poem fails', async () => {
    const existing = local('existing');
    const saved = local('saved');
    const failed = local('failed');
    mocks.files.set(existing.audioUrl, 'original');
    const parsed = parse(backup(2, [
      poem('existing', existing), poem('saved', saved), poem('failed', failed),
    ], [
      { poemId: 'existing', recordingId: existing.id, base64: 'YQ==' },
      { poemId: 'saved', recordingId: saved.id, base64: 'Yg==' },
      { poemId: 'failed', recordingId: failed.id, base64: 'Yw==' },
    ]));
    const savePoem = vi.fn(async (item: Poem) => {
      if (item.id === 'failed') throw new Error('Save failed');
      return true;
    });

    await expect(restoreBackupAudio(parsed, new Set(['existing']), savePoem))
      .rejects.toThrow('Save failed');
    expect(savePoem.mock.calls.map(([item]) => item.id)).toEqual(['saved', 'failed']);
    expect(mocks.deleted).toEqual([failed.audioUrl]);
    expect(mocks.files.get(existing.audioUrl)).toBe('original');
    expect(mocks.files.get(saved.audioUrl)).toBe('Yg==');
    expect(mocks.files.has(failed.audioUrl)).toBe(false);
  });

  it('discards extracted audio for a duplicate external poem with a different local ID', async () => {
    const duplicateAudio = local('duplicate');
    const nextAudio = local('next');
    const duplicate = {
      ...poem('backup-id', duplicateAudio),
      externalProvider: 'mizan_al_arab',
      externalId: '123',
    };
    const parsed = parse(backup(2, [duplicate, poem('next-id', nextAudio)], [
      { poemId: duplicate.id, recordingId: duplicateAudio.id, base64: 'YQ==' },
      { poemId: 'next-id', recordingId: nextAudio.id, base64: 'Yg==' },
    ]));
    const savedIds = new Set(['local-id']);
    const savePoem = vi.fn(async (item: Poem) => {
      if (item.externalProvider === 'mizan_al_arab' && item.externalId === '123') return false;
      savedIds.add(item.id);
      return true;
    });

    const restored = await restoreBackupAudio(parsed, savedIds, savePoem);
    expect(savePoem.mock.calls.map(([item]) => item.id)).toEqual(['backup-id', 'next-id']);
    expect(restored.map((item) => item.id)).toEqual(['next-id']);
    expect(mocks.deleted).toEqual([duplicateAudio.audioUrl]);
    expect(mocks.files.has(duplicateAudio.audioUrl)).toBe(false);
    expect(mocks.files.get(nextAudio.audioUrl)).toBe('Yg==');
    expect(savedIds.has('backup-id')).toBe(false);
  });

  it('removes every new recording for the poem whose save fails', async () => {
    const first = local('first');
    const second = local('second');
    const parsed = parse(backup(2, [{
      ...poem('new', first), recordings: [first, second],
    }], [
      { poemId: 'new', recordingId: first.id, base64: 'YQ==' },
      { poemId: 'new', recordingId: second.id, base64: 'Yg==' },
    ]));
    await expect(restoreBackupAudio(parsed, new Set(), async () => {
      throw new Error('Save failed');
    })).rejects.toThrow('Save failed');
    expect(mocks.deleted).toEqual([first.audioUrl, second.audioUrl]);
    expect(mocks.files.size).toBe(0);
  });

  it('reports only the audio left behind when cleanup after a failed save partially fails', async () => {
    const existing = local('existing');
    const first = local('first');
    const second = local('second');
    mocks.files.set(existing.audioUrl, 'original');
    mocks.deleteFailures.add(second.audioUrl);
    const parsed = parse(backup(2, [
      poem('existing', existing),
      { ...poem('new', first), recordings: [first, second] },
    ], [
      { poemId: 'existing', recordingId: existing.id, base64: 'Yw==' },
      { poemId: 'new', recordingId: first.id, base64: 'YQ==' },
      { poemId: 'new', recordingId: second.id, base64: 'Yg==' },
    ]));

    await expect(restoreBackupAudio(parsed, new Set(['existing']), async () => {
      throw new Error('Save failed');
    })).rejects.toThrow(`Save failed\nتعذر حذف ملفات الصوت الجديدة التالية بعد فشل الاستعادة: ${second.audioUrl}`);
    expect(mocks.deleted).toEqual([first.audioUrl, second.audioUrl]);
    expect(mocks.files.has(first.audioUrl)).toBe(false);
    expect(mocks.files.get(second.audioUrl)).toBe('Yg==');
    expect(mocks.files.get(existing.audioUrl)).toBe('original');
  });

  it('rejects missing local audio on export and on v1/v2 restore without fallback', async () => {
    const missing = poem('missing', local('missing'));
    mocks.storage.set('diwan.mobile.poems.v1', JSON.stringify([missing]));
    await expect(createBackupJson()).rejects.toThrow('missing');
    for (const version of [1, 2] as const) {
      await expect(restoreBackupAudio(parse(backup(version, [missing], version === 2 ? [] : undefined)), new Set()))
        .rejects.toThrow('missing');
    }
    expect(mocks.files.size).toBe(0);
  });

  it('falls back to a remote URL when the local file is missing in either backup version', async () => {
    for (const version of [1, 2] as const) {
      const parsed = parse(backup(version, [poem('remote', remote('remote'))], version === 2 ? [] : undefined));
      const [restored] = await restoreBackupAudio(parsed, new Set());
      expect(restored.recording?.audioUrl).toBe('https://example.com/remote.mp3');
      expect(restored.recordings?.[0].audioUrl).toBe('https://example.com/remote.mp3');
    }
  });

  it('rejects zero-length, reversed, and nonfinite timing boundaries in backups', () => {
    const original = backup(1, [poem('bad', local('bad'))]);
    for (const [startMs, endMs] of [[10, 10], [20, 10], [-1, 10], [10, Infinity]]) {
      const copy = structuredClone(original);
      copy.poems[0].verses[0].alignment = { startMs, endMs, confidence: 1 };
      expect(() => parse(copy)).toThrow();
    }
    const copy = structuredClone(original);
    copy.poems[0].verses[0].recordingAlignments = {
      bad: { startMs: 20, endMs: 10, confidence: 1 },
    };
    expect(() => parse(copy)).toThrow();
  });

  it('rejects duplicate audio entries and audio not belonging to a recording', () => {
    const item = { poemId: 'a', recordingId: 'one', base64: 'YQ==' };
    const original = poem('a', local('one'));
    expect(() => parse(backup(2, [original], [item, item]))).toThrow();
    expect(() => parse(backup(2, [original], [{ ...item, recordingId: 'other' }]))).toThrow();
  });

  it('maps a duplicate imported poem to its existing local ID in imported playlists', async () => {
    const existing: Poem = {
      ...poem('local-id', local('existing')),
      externalProvider: 'mizan_al_arab', externalId: '123',
    };
    const duplicate: Poem = {
      ...poem('backup-id', local('duplicate')),
      externalProvider: 'mizan_al_arab', externalId: '123',
    };
    const incoming: Playlist = {
      id: 'imported-list', name: 'المفضلة',
      poemIds: ['backup-id', 'local-id', 'new-id'], createdAt: 1,
    };
    const parsed = parse({
      ...backup(2, [duplicate, poem('new-id', local('new'))], [
        { poemId: 'backup-id', recordingId: 'duplicate', base64: 'YQ==' },
        { poemId: 'new-id', recordingId: 'new', base64: 'Yg==' },
      ]),
      playlists: [incoming],
    });
    assertBackupPlaylistReferences(parsed, [existing.id]);
    const saved = [existing];
    const savedIds = new Set(saved.map((item) => item.id));
    const remappedIds = new Map<string, string>();
    await restoreBackupAudio(parsed, savedIds, async (item) => {
      const match = saved.find((candidate) =>
        candidate.id === item.id ||
        (item.externalProvider !== undefined && item.externalId !== undefined &&
          candidate.externalProvider === item.externalProvider && candidate.externalId === item.externalId));
      if (match) {
        if (match.id !== item.id) remappedIds.set(item.id, match.id);
        return false;
      }
      saved.push(item);
      savedIds.add(item.id);
      return true;
    });
    expect(remapBackupPlaylists(parsed.playlists, remappedIds)).toEqual([
      { ...incoming, poemIds: ['local-id', 'new-id'] },
    ]);
    expect(parsed.playlists[0].poemIds).toEqual(['backup-id', 'local-id', 'new-id']);
    expect(mocks.files.has(duplicate.recording!.audioUrl)).toBe(false);
    expect(mocks.files.get('file:///documents/recording-audio/new.mp3')).toBe('Yg==');
  });

  it('rejects unknown playlist references before restoring anything', () => {
    const invalid = parse({
      ...backup(1, [poem('backup-id', remote('backup'))]),
      playlists: [{ id: 'imported-list', name: 'مفقودة', poemIds: ['unknown-id'], createdAt: 1 }],
    });
    expect(() => assertBackupPlaylistReferences(invalid, ['local-id'])).toThrow('غير موجودة');
    expect(mocks.files.size).toBe(0);
  });
});