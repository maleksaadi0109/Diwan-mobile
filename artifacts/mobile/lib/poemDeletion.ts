import type { Playlist, Poem } from './types';

export function withoutPoemIds(playlists: Playlist[], ids: ReadonlySet<string>): Playlist[] {
  return playlists.map((playlist) => {
    const poemIds = playlist.poemIds.filter((id) => !ids.has(id));
    return poemIds.length === playlist.poemIds.length
      ? playlist
      : { ...playlist, poemIds };
  });
}

// Persist playlist cleanup first: a failed cleanup must not leave deleted poem
// IDs in playlists, which would make backup export reject the entire library.
export function createPoemRemoval(
  removeFromPlaylists: (ids: string[]) => Promise<void>,
  updatePoems: (updater: (current: Poem[]) => Poem[]) => Promise<void>,
) {
  const removePoems = async (ids: string[]) => {
    if (ids.length === 0) return;
    const idsToRemove = new Set(ids);
    await removeFromPlaylists(ids);
    await updatePoems((current) => current.filter((poem) => !idsToRemove.has(poem.id)));
  };
  return {
    removePoem: (id: string) => removePoems([id]),
    removePoems,
  };
}