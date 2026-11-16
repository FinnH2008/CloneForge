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

const FILENAME_NOISE_PATTERNS: RegExp[] = [
  /\s*[\(\[]\s*(official\s*(music\s*)?video|official\s*audio|music\s*video|lyric\s*video|lyrics?|visualizer|audio\s*only|hd|4k|1080p|720p|hq|explicit|clean|remastered(\s*\d{4})?)\s*[\)\]]/gi,
  /\s*[-|]\s*(official\s*(music\s*)?video|lyric\s*video|official\s*audio)$/gi,
];

export function cleanMediaTitle(raw: string): string {
  let cleaned = raw.replace(/_/g, ' ').trim();
  for (const pattern of FILENAME_NOISE_PATTERNS) {
    cleaned = cleaned.replace(pattern, '');
  }
  return cleaned.replace(/\s{2,}/g, ' ').trim();
}

export function parseFilenameMetadata(filename: string): {artist: string; title: string} {
  const base = filename.replace(/\.[^/.]+$/, '').replace(/_/g, ' ').trim();
  const separators = [' - ', ' – ', ' — '];
  for (const sep of separators) {
    const idx = base.indexOf(sep);
    if (idx > 0 && idx < base.length - sep.length) {
      const artist = cleanMediaTitle(base.slice(0, idx));
      const title = cleanMediaTitle(base.slice(idx + sep.length));
      return {
        artist,
        title: title || cleanMediaTitle(base),
      };
    }
  }
  return {
    artist: '',
    title: cleanMediaTitle(base) || 'Unbenannter Song',
  };
}
