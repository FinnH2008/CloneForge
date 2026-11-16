import type {LrcLibResult} from '../types/chart';

export interface RawMusicBrainzRelease {
  id: string;
  title?: string;
  date?: string;
  country?: string;
  status?: string;
  'track-count'?: number;
  'release-group'?: {
    id?: string;
    'primary-type'?: string;
    'secondary-types'?: string[];
  };
  'cover-art-archive'?: {
    artwork?: boolean;
    front?: boolean;
  };
}

export interface RawMusicBrainzRecording {
  id: string;
  title?: string;
  score?: number;
  length?: number;
  video?: boolean | null;
  disambiguation?: string;
  'first-release-date'?: string;
  'artist-credit'?: Array<{
    name?: string;
    joinphrase?: string;
    artist?: {id?: string; name?: string};
  }>;
  releases?: RawMusicBrainzRelease[];
  tags?: Array<{name: string; count?: number}>;
  genres?: Array<{name: string; count?: number}>;
}

const NON_MUSICAL_TAGS = new Set([
  'music video',
  'video',
  'official video',
  'seen live',
  'favorites',
  'favourite',
  'usa',
  'uk',
  'german',
]);

const COMPILATION_TITLE_HINTS =
  /\b(hits|best of|greatest|collection|anthology|100 from|thunder|now that's|soundtrack|motion picture|karaoke|tribute|compilation|chart|party|workout|essentials|playlist)\b/i;

const VERSION_PENALTY_HINTS =
  /\b(official video|music video|karaoke|instrumental|remix|re-recorded|nightcore|sped up|slowed|live at|live in|live from|acoustic|demo|radio edit)\b/i;

export function scoreMusicBrainzRelease(
  rel: RawMusicBrainzRelease,
  preferQueryHint: string = '',
  canonicalAlbumHint: string = ''
): number {
  let score = 0;
  const title = rel.title || '';
  const rg = rel['release-group'];
  const primary = rg?.['primary-type'] || '';
  const secondary = rg?.['secondary-types'] || [];

  if (rel.status === 'Official') score += 45;
  if (primary === 'Album' && secondary.length === 0) score += 85;
  else if (primary === 'Album') score += 40;
  else if (primary === 'Single') score += 28;
  else if (primary === 'EP') score += 24;

  if (
    canonicalAlbumHint &&
    title.toLowerCase().trim() === canonicalAlbumHint.toLowerCase().trim()
  ) {
    score += 95;
  }

  for (const sec of secondary) {
    if (
      [
        'Compilation',
        'Soundtrack',
        'Live',
        'Remix',
        'DJ-mix',
        'Mixtape/Street',
        'Demo',
        'Interview',
      ].includes(sec)
    ) {
      if (!preferQueryHint.toLowerCase().includes(sec.toLowerCase())) {
        score -= 110;
      }
    }
  }

  if (COMPILATION_TITLE_HINTS.test(title) && !COMPILATION_TITLE_HINTS.test(preferQueryHint)) {
    score -= 95;
  }

  if (VERSION_PENALTY_HINTS.test(title) && !VERSION_PENALTY_HINTS.test(preferQueryHint)) {
    score -= 90;
  }

  if (rel['cover-art-archive']?.front) {
    score += 24;
  }

  const yearMatch = (rel.date || '').match(/^(\d{4})/);
  if (yearMatch) {
    // Earlier studio releases beat late compilations and remixes
    const year = Number(yearMatch[1]);
    if (year >= 1950 && year <= 2030) {
      score += Math.max(0, 2030 - year) * 0.65;
    }
  }

  return score;
}

export function scoreMusicBrainzRecording(
  rec: RawMusicBrainzRecording,
  durationSec?: number,
  queryHint: string = '',
  activeDurationSec?: number,
  canonicalAlbumHint: string = ''
): number {
  let score = typeof rec.score === 'number' ? rec.score : 50;
  const title = rec.title || '';

  if (rec.video === true && !queryHint.toLowerCase().includes('video')) {
    score -= 110;
  }

  if (VERSION_PENALTY_HINTS.test(title) && !VERSION_PENALTY_HINTS.test(queryHint)) {
    score -= 80;
  }

  if (COMPILATION_TITLE_HINTS.test(title) && !COMPILATION_TITLE_HINTS.test(queryHint)) {
    score -= 65;
  }

  if (typeof rec.length === 'number' && rec.length > 5000) {
    const recSec = rec.length / 1000;
    const d1 = durationSec && durationSec > 5 ? Math.abs(recSec - durationSec) : Infinity;
    const d2 =
      activeDurationSec && activeDurationSec > 5 ? Math.abs(recSec - activeDurationSec) : Infinity;
    const bestDiff = Math.min(d1, d2);

    if (bestDiff <= 4) score += 42;
    else if (bestDiff <= 12) score += 22;
    else if (bestDiff <= 25) score += 6;
    else if (bestDiff > 55) score -= 28;
  }

  const releases = Array.isArray(rec.releases) ? rec.releases : [];
  if (releases.length > 0) {
    const bestRelScore = Math.max(
      ...releases.map((r) => scoreMusicBrainzRelease(r, queryHint, canonicalAlbumHint))
    );
    score += bestRelScore * 0.65;
  } else {
    score -= 55;
  }

  return score;
}

export function extractBestMusicGenre(
  tags?: Array<{name: string; count?: number}>,
  genres?: Array<{name: string; count?: number}>
): string {
  const pool = [...(genres || []), ...(tags || [])]
    .filter((t) => t?.name && !NON_MUSICAL_TAGS.has(t.name.toLowerCase().trim()))
    .sort((a, b) => (b.count || 0) - (a.count || 0));

  if (pool.length === 0) return '';
  const name = pool[0].name.trim();
  return name.charAt(0).toUpperCase() + name.slice(1);
}

export function pickBestLyricsResult(
  results: LrcLibResult[],
  durationSec?: number,
  expectedTitle?: string,
  activeDurationSec?: number,
  expectedArtist?: string,
  expectedAlbum?: string
): LrcLibResult | null {
  if (results.length === 0) return null;

  let best: LrcLibResult | null = null;
  let bestScore = -Infinity;

  const titleLower = (expectedTitle || '').toLowerCase().trim();
  const artistLower = (expectedArtist || '').toLowerCase().trim();
  const albumLower = (expectedAlbum || '').toLowerCase().trim();

  for (const item of results) {
    if (!item.syncedLyrics && !item.plainLyrics) continue;
    let score = 0;

    if (item.hasSynced && item.syncedLyrics) score += 130;
    if (item.instrumental) score -= 90;

    const itemTrackLower = (item.trackName || '').toLowerCase().trim();
    const itemArtistLower = (item.artistName || '').toLowerCase().trim();
    const itemAlbumLower = (item.albumName || '').toLowerCase().trim();

    if (VERSION_PENALTY_HINTS.test(itemTrackLower) && !VERSION_PENALTY_HINTS.test(titleLower)) {
      score -= 35;
    }

    if (item.duration > 0) {
      const d1 = durationSec && durationSec > 5 ? Math.abs(item.duration - durationSec) : Infinity;
      const d2 =
        activeDurationSec && activeDurationSec > 5
          ? Math.abs(item.duration - activeDurationSec)
          : Infinity;
      const diff = Math.min(d1, d2);
      if (diff <= 3) score += 55;
      else if (diff <= 10) score += 30;
      else if (diff <= 25) score += 10;
      else if (diff > 45) score -= 35;
    }

    if (titleLower) {
      if (itemTrackLower === titleLower) score += 28;
      else if (itemTrackLower.includes(titleLower)) score += 14;
    }

    if (artistLower) {
      if (itemArtistLower === artistLower) score += 24;
      else if (itemArtistLower.includes(artistLower) || artistLower.includes(itemArtistLower)) {
        score += 12;
      }
    }

    if (albumLower && itemAlbumLower && itemAlbumLower !== 'null') {
      if (itemAlbumLower === albumLower) score += 25;
      else if (itemAlbumLower.includes(albumLower)) score += 12;
    } else if (itemAlbumLower && itemAlbumLower !== 'null' && !COMPILATION_TITLE_HINTS.test(itemAlbumLower)) {
      score += 6;
    }

    if (score > bestScore) {
      bestScore = score;
      best = item;
    }
  }

  return best;
}

