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
  /\b(hits|best of|greatest|collection|anthology|100 from|thunder|now that's|soundtrack|motion picture|karaoke|tribute)\b/i;

const VERSION_PENALTY_HINTS =
  /\b(official video|music video|karaoke|instrumental|remix|nightcore|sped up|slowed|live at|acoustic)\b/i;

export function scoreMusicBrainzRelease(
  rel: RawMusicBrainzRelease,
  preferQueryHint: string = ''
): number {
  let score = 0;
  const title = rel.title || '';
  const rg = rel['release-group'];
  const primary = rg?.['primary-type'] || '';
  const secondary = rg?.['secondary-types'] || [];

  if (rel.status === 'Official') score += 45;
  if (primary === 'Album') score += 50;
  else if (primary === 'Single') score += 34;
  else if (primary === 'EP') score += 26;

  for (const sec of secondary) {
    if (['Compilation', 'Soundtrack', 'Live', 'Remix', 'DJ-mix', 'Mixtape/Street'].includes(sec)) {
      if (!preferQueryHint.toLowerCase().includes(sec.toLowerCase())) {
        score -= 70;
      }
    }
  }

  if (COMPILATION_TITLE_HINTS.test(title) && !COMPILATION_TITLE_HINTS.test(preferQueryHint)) {
    score -= 55;
  }

  if (VERSION_PENALTY_HINTS.test(title) && !VERSION_PENALTY_HINTS.test(preferQueryHint)) {
    score -= 45;
  }

  if (rel['cover-art-archive']?.front) {
    score += 22;
  }

  const yearMatch = (rel.date || '').match(/^(\d{4})/);
  if (yearMatch) {
    // Earlier studio releases beat late compilations
    const year = Number(yearMatch[1]);
    if (year >= 1950 && year <= 2030) {
      score += Math.max(0, 2030 - year) * 0.4;
    }
  }

  return score;
}

export function scoreMusicBrainzRecording(
  rec: RawMusicBrainzRecording,
  durationSec?: number,
  queryHint: string = ''
): number {
  let score = typeof rec.score === 'number' ? rec.score : 50;
  const title = rec.title || '';

  if (rec.video === true && !queryHint.toLowerCase().includes('video')) {
    score -= 90;
  }

  if (VERSION_PENALTY_HINTS.test(title) && !VERSION_PENALTY_HINTS.test(queryHint)) {
    score -= 65;
  }

  if (durationSec && durationSec > 5 && typeof rec.length === 'number') {
    const diffSec = Math.abs(rec.length / 1000 - durationSec);
    if (diffSec <= 4) score += 35;
    else if (diffSec <= 12) score += 18;
    else if (diffSec > 45) score -= 25;
  }

  const releases = Array.isArray(rec.releases) ? rec.releases : [];
  if (releases.length > 0) {
    const bestRelScore = Math.max(...releases.map((r) => scoreMusicBrainzRelease(r, queryHint)));
    score += bestRelScore * 0.55;
  } else {
    score -= 40;
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
  expectedTitle?: string
): LrcLibResult | null {
  if (results.length === 0) return null;

  let best: LrcLibResult | null = null;
  let bestScore = -Infinity;

  const titleLower = (expectedTitle || '').toLowerCase();

  for (const item of results) {
    if (!item.syncedLyrics && !item.plainLyrics) continue;
    let score = 0;

    if (item.hasSynced && item.syncedLyrics) score += 120;
    if (item.instrumental) score -= 80;
    if (VERSION_PENALTY_HINTS.test(item.trackName) && !VERSION_PENALTY_HINTS.test(titleLower)) {
      score -= 35;
    }

    if (durationSec && durationSec > 5 && item.duration > 0) {
      const diff = Math.abs(item.duration - durationSec);
      if (diff <= 3) score += 50;
      else if (diff <= 10) score += 25;
      else if (diff > 30) score -= 40;
    }

    if (titleLower && item.trackName.toLowerCase().trim() === titleLower) {
      score += 20;
    }

    if (score > bestScore) {
      bestScore = score;
      best = item;
    }
  }

  return best;
}
