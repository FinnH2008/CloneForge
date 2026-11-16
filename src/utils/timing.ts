import type {BpmMarker, QuantizeGrid} from '../types/chart';

export const DEFAULT_RESOLUTION = 192;

/**
 * Converts a timestamp in seconds to a .chart tick position,
 * accounting for global offset (ms) and variable BPM markers.
 */
export function timeSecToTick(
  timeSec: number,
  bpmMarkers: BpmMarker[],
  resolution: number = DEFAULT_RESOLUTION,
  offsetMs: number = 0
): number {
  const sorted = [...bpmMarkers].sort((a, b) => a.tick - b.tick);
  const effectiveSec = Math.max(0, timeSec - offsetMs / 1000);
  if (sorted.length === 0) {
    return Math.round(effectiveSec * (120 / 60) * resolution);
  }

  let currentSec = 0;
  let currentTick = 0;

  for (let i = 0; i < sorted.length; i++) {
    const marker = sorted[i];
    const bpm = Math.max(20, marker.bpm);
    const secPerTick = 60 / (bpm * resolution);
    const nextMarker = sorted[i + 1];

    if (!nextMarker) {
      const remainingSec = effectiveSec - currentSec;
      return Math.max(0, Math.round(currentTick + remainingSec / secPerTick));
    }

    const deltaTicks = Math.max(0, nextMarker.tick - currentTick);
    const segmentSec = deltaTicks * secPerTick;
    if (effectiveSec <= currentSec + segmentSec) {
      const remainingSec = effectiveSec - currentSec;
      return Math.max(0, Math.round(currentTick + remainingSec / secPerTick));
    }

    currentSec += segmentSec;
    currentTick = nextMarker.tick;
  }

  return currentTick;
}

/**
 * Converts a .chart tick position to seconds, accounting for BPM markers and offset (ms).
 */
export function tickToTimeSec(
  tick: number,
  bpmMarkers: BpmMarker[],
  resolution: number = DEFAULT_RESOLUTION,
  offsetMs: number = 0
): number {
  const sorted = [...bpmMarkers].sort((a, b) => a.tick - b.tick);
  const targetTick = Math.max(0, tick);
  if (sorted.length === 0) {
    return offsetMs / 1000 + (targetTick / resolution) * (60 / 120);
  }

  let currentSec = offsetMs / 1000;
  let currentTick = 0;

  for (let i = 0; i < sorted.length; i++) {
    const marker = sorted[i];
    const bpm = Math.max(20, marker.bpm);
    const secPerTick = 60 / (bpm * resolution);
    const nextMarker = sorted[i + 1];

    if (!nextMarker || targetTick <= nextMarker.tick) {
      return currentSec + Math.max(0, targetTick - currentTick) * secPerTick;
    }

    currentSec += Math.max(0, nextMarker.tick - currentTick) * secPerTick;
    currentTick = nextMarker.tick;
  }

  return currentSec;
}

export function getGridStepTicks(resolution: number, grid: QuantizeGrid): number {
  return Math.max(1, Math.round((resolution * 4) / grid));
}

export function quantizeTick(
  tick: number,
  resolution: number = DEFAULT_RESOLUTION,
  grid: QuantizeGrid = 16
): number {
  const step = getGridStepTicks(resolution, grid);
  return Math.max(0, Math.round(tick / step) * step);
}

export function formatTimecode(seconds: number): string {
  const safe = Math.max(0, seconds);
  const mins = Math.floor(safe / 60);
  const secs = Math.floor(safe % 60);
  const centis = Math.floor((safe % 1) * 100);
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(centis).padStart(2, '0')}`;
}

const DOWNLOADER_PREFIX_RE =
  /^(?:\[[^\]]*(?:y2mate|yt5s|yt1s|spotifymate|spotifydown|savefrom|loader|mp3juices)[^\]]*\]|(?:y2mate|yt5s|yt1s|spotifymate|spotifydown|savefrom)\.(?:com|io|is|org|net))\s*[-_:|]*\s*/i;

const LEADING_TRACK_NUM_RE = /^(?:track\s*)?\d{1,3}\s*(?:\.|-|–|—|\))\s+/i;

const YOUTUBE_ID_SUFFIX_RE = /\s*[\(\[][A-Za-z0-9_-]{11}[\)\]]\s*$/;

const FILENAME_NOISE_PATTERNS: RegExp[] = [
  /\s*[\(\[]\s*(?:official\s*(?:hd\s*|4k\s*)?(?:music\s*)?video|official\s*(?:lyric\s*)?video|official\s*audio|music\s*video|lyric\s*video|lyrics?\s*video|lyrics?|visualizer|official\s*visualizer|audio\s*only|full\s*audio|hd|4k|1080p|720p|hq|explicit|clean|remastered(?:\s*\d{4})?|\d{2,3}\s*kbps)\s*[\)\]]/gi,
  /\s*[-|–—]\s*(?:official\s*(?:hd\s*)?(?:music\s*)?video|lyric\s*video|official\s*audio|visualizer|lyrics?)$/gi,
  /\s+\b(?:official\s+music\s+video|official\s+video|official\s+lyric\s+video|lyric\s+video|official\s+audio|1080p|720p|4k\s+hd|320kbps|128kbps)\b/gi,
  /\s*-\s*topic$/i,
];

export function sanitizeArtistForQuery(artist?: string | null): string {
  if (!artist) return '';
  const trimmed = artist.trim();
  if (
    !trimmed ||
    /^(unbekannter\s*interpret|unknown(\s*artist)?|various(\s*artists)?|track\s*\d*)$/i.test(
      trimmed
    )
  ) {
    return '';
  }
  return trimmed;
}

function normalizeKebabSlugSegment(segment: string): string {
  const trimmed = segment.trim();
  const dashCount = (trimmed.match(/-/g) || []).length;
  const spaceCount = (trimmed.match(/\s/g) || []).length;
  // If a segment has multiple hyphens and no spaces (e.g. "troopers-of-the-stars-official-video"), replace hyphens with spaces
  if (dashCount >= 2 && spaceCount === 0) {
    return trimmed.replace(/-/g, ' ').replace(/\s{2,}/g, ' ').trim();
  }
  return trimmed;
}

export function cleanMediaTitle(raw: string): string {
  let cleaned = raw
    .replace(/_/g, ' ')
    .replace(/---+/g, ' - ')
    .replace(/--+/g, ' - ')
    .replace(DOWNLOADER_PREFIX_RE, '')
    .replace(YOUTUBE_ID_SUFFIX_RE, '')
    .trim();

  cleaned = cleaned
    .split(' - ')
    .map((part) => normalizeKebabSlugSegment(part))
    .join(' - ');

  for (const pattern of FILENAME_NOISE_PATTERNS) {
    cleaned = cleaned.replace(pattern, '');
  }
  return cleaned.replace(/\s{2,}/g, ' ').replace(/^[-–—|:\s]+|[-–—|:\s]+$/g, '').trim();
}

export function parseFilenameMetadata(filename: string): {artist: string; title: string} {
  let base = filename
    .replace(/\.[^/.]+$/, '')
    .replace(/_/g, ' ')
    .replace(/---+/g, ' - ')
    .replace(/--+/g, ' - ')
    .replace(DOWNLOADER_PREFIX_RE, '')
    .replace(YOUTUBE_ID_SUFFIX_RE, '')
    .trim();

  // Strip leading track numbers like "01 - " or "03. " BEFORE splitting Artist - Title
  base = base.replace(LEADING_TRACK_NUM_RE, '').trim();

  const separators = [' - ', ' – ', ' — ', ' | ', ' // ', ' : '];
  for (const sep of separators) {
    if (base.includes(sep)) {
      const parts = base
        .split(sep)
        .map((p) => cleanMediaTitle(normalizeKebabSlugSegment(p)))
        .filter(Boolean);

      if (parts.length >= 3) {
        // E.g. "troopers-of-the-stars-official-video --- extreme-power-metal --- dragonforce"
        // or "Artist - Album - Title": preserve first & last, let Audio-ID catalog disambiguate if swapped
        return {
          artist: sanitizeArtistForQuery(parts[0]),
          title: parts[parts.length - 1] || cleanMediaTitle(base),
        };
      }
      if (parts.length === 2) {
        return {
          artist: sanitizeArtistForQuery(parts[0]),
          title: parts[1] || cleanMediaTitle(base),
        };
      }
    }
  }

  base = normalizeKebabSlugSegment(base);

  // Check "Title by Artist" pattern
  const byMatch = base.match(/^(.+?)\s+by\s+(.+)$/i);
  if (byMatch) {
    return {
      artist: sanitizeArtistForQuery(cleanMediaTitle(byMatch[2])),
      title: cleanMediaTitle(byMatch[1]) || cleanMediaTitle(base),
    };
  }

  // Check single hyphen without spaces ONLY when there is a single hyphen in the string (e.g. "Motionless in White-Another Life")
  const hyphenCount = (base.match(/-/g) || []).length;
  if (hyphenCount === 1) {
    const singleDashMatch = base.match(
      /^([A-Za-z0-9ÄÖÜäöüß.&'\s]{3,})\-([A-Za-z0-9ÄÖÜäöüß.&'\s()\[\]]{3,})$/
    );
    if (singleDashMatch) {
      const artist = sanitizeArtistForQuery(cleanMediaTitle(singleDashMatch[1]));
      const title = cleanMediaTitle(singleDashMatch[2]);
      if (artist && title) {
        return {artist, title};
      }
    }
  }

  return {
    artist: '',
    title: cleanMediaTitle(base) || 'Unbenannter Song',
  };
}


