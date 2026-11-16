import type {
  AnyFretId,
  BpmMarker,
  ChartNote,
  ChartSectionMarker,
  ChartTracks,
  Difficulty,
  LyricPhrase,
  SongMetadata,
  StarPowerPhrase,
  TimeSignatureMarker,
} from '../types/chart';
import {DIFFICULTIES} from './difficultyPresets';
import {DEFAULT_RESOLUTION} from './timing';

export const FIVE_FRET_TO_CHART_LANE: Record<string, number> = {
  G: 0,
  R: 1,
  Y: 2,
  B: 3,
  O: 4,
  OPEN: 7,
};

/**
 * Exact Clone Hero / Moonscraper .chart integer mapping for 6-Fret GHL:
 * 0 = White 1, 1 = White 2, 2 = White 3,
 * 3 = Black 1, 4 = Black 2, 8 = Black 3,
 * 5 = Forced flag, 6 = Tap flag, 7 = Open Note.
 */
export const GHL_FRET_TO_CHART_LANE: Record<string, number> = {
  W1: 0,
  W2: 1,
  W3: 2,
  B1: 3,
  B2: 4,
  B3: 8,
  OPEN: 7,
};

function escapeIni(value: string): string {
  return value.replace(/\r?\n/g, ' ').trim();
}

function escapeChartString(value: string): string {
  return value.replace(/"/g, "'").replace(/\r?\n/g, ' ').trim();
}

function serializeNoteTrackSection(
  sectionName: string,
  notes: ChartNote[],
  starPower: StarPowerPhrase[],
  laneMap: Record<string, number>
): string {
  const lines: string[] = [`[${sectionName}]`, '{'];

  // Group notes by tick so Forced (5) and Tap (6) flags are emitted once per tick cleanly
  const byTick = new Map<number, ChartNote[]>();
  for (const n of notes) {
    const arr = byTick.get(n.tick) || [];
    arr.push(n);
    byTick.set(n.tick, arr);
  }

  type Row = {tick: number; order: number; text: string};
  const rows: Row[] = [];

  for (const [tick, tickNotes] of byTick.entries()) {
    const seenLanes = new Set<number>();
    let anyForced = false;
    let anyTap = false;

    for (const note of tickNotes) {
      const lane = laneMap[note.fret];
      if (lane === undefined || seenLanes.has(lane)) continue;
      seenLanes.add(lane);
      rows.push({
        tick,
        order: lane,
        text: `  ${tick} = N ${lane} ${Math.max(0, Math.round(note.sustain))}`,
      });
      if (note.forced) anyForced = true;
      if (note.tap) anyTap = true;
    }

    if (anyForced) {
      rows.push({tick, order: 5, text: `  ${tick} = N 5 0`});
    }
    if (anyTap) {
      rows.push({tick, order: 6, text: `  ${tick} = N 6 0`});
    }
  }

  for (const sp of starPower) {
    rows.push({
      tick: sp.tick,
      order: 99,
      text: `  ${sp.tick} = S 2 ${Math.max(1, Math.round(sp.duration))}`,
    });
  }

  rows.sort((a, b) => (a.tick !== b.tick ? a.tick - b.tick : a.order - b.order));
  for (const r of rows) {
    lines.push(r.text);
  }

  lines.push('}');
  return lines.join('\n');
}

export interface SerializeChartParams {
  metadata: SongMetadata;
  bpmMarkers: BpmMarker[];
  timeSignatures?: TimeSignatureMarker[];
  sections?: ChartSectionMarker[];
  lyrics: LyricPhrase[];
  tracks: ChartTracks;
  offsetMs: number;
  resolution?: number;
  audioFilename?: string;
}

export function serializeChartFile(params: SerializeChartParams): string {
  const {
    metadata,
    bpmMarkers,
    timeSignatures = [{tick: 0, numerator: 4, denominator: 4}],
    sections = [],
    lyrics,
    tracks,
    offsetMs,
    resolution = DEFAULT_RESOLUTION,
    audioFilename = 'song.mp3',
  } = params;

  const out: string[] = [];

  // [Song]
  out.push('[Song]');
  out.push('{');
  out.push(`  Name = "${escapeChartString(metadata.title || 'Unbenannter Song')}"`);
  out.push(`  Artist = "${escapeChartString(metadata.artist || 'Unbekannter Interpret')}"`);
  out.push(`  Charter = "${escapeChartString(metadata.charter || 'CloneForge Studio')}"`);
  out.push(`  Album = "${escapeChartString(metadata.album || '')}"`);
  out.push(`  Year = ", ${escapeChartString(metadata.year || '')}"`);
  out.push(`  Offset = ${Number((offsetMs / 1000).toFixed(4))}`);
  out.push(`  Resolution = ${resolution}`);
  out.push('  Player2 = bass');
  out.push('  Difficulty = 0');
  out.push(`  PreviewStart = ${Number((metadata.previewStartMs / 1000).toFixed(2))}`);
  out.push('  PreviewEnd = 0');
  out.push(`  Genre = "${escapeChartString(metadata.genre || 'Rock')}"`);
  out.push('  MediaType = "cd"');
  out.push(`  MusicStream = "${escapeChartString(audioFilename)}"`);
  out.push('}');

  // [SyncTrack]
  out.push('[SyncTrack]');
  out.push('{');
  const syncRows: {tick: number; order: number; text: string}[] = [];

  for (const ts of timeSignatures) {
    const exp = Math.max(0, Math.round(Math.log2(ts.denominator || 4)));
    syncRows.push({
      tick: ts.tick,
      order: 0,
      text: `  ${ts.tick} = TS ${ts.numerator}${exp !== 2 ? ` ${exp}` : ''}`,
    });
  }

  const sortedBpms = [...bpmMarkers].sort((a, b) => a.tick - b.tick);
  if (sortedBpms.length === 0) {
    syncRows.push({tick: 0, order: 1, text: '  0 = B 120000'});
  } else {
    for (const b of sortedBpms) {
      syncRows.push({
        tick: b.tick,
        order: 1,
        text: `  ${b.tick} = B ${Math.round(Math.max(20, b.bpm) * 1000)}`,
      });
    }
  }

  syncRows.sort((a, b) => (a.tick !== b.tick ? a.tick - b.tick : a.order - b.order));
  for (const r of syncRows) out.push(r.text);
  out.push('}');

  // [Events] — Sections & Clone Hero Lyrics
  out.push('[Events]');
  out.push('{');
  const eventRows: {tick: number; order: number; text: string}[] = [];

  for (const sec of sections) {
    eventRows.push({
      tick: sec.tick,
      order: 0,
      text: `  ${sec.tick} = E "section ${escapeChartString(sec.name)}"`,
    });
  }

  const sortedPhrases = [...lyrics].sort((a, b) => a.startTick - b.startTick);
  for (const phrase of sortedPhrases) {
    eventRows.push({
      tick: phrase.startTick,
      order: 1,
      text: `  ${phrase.startTick} = E "phrase_start"`,
    });
    for (const syl of phrase.syllables) {
      const clean = escapeChartString(syl.text);
      if (!clean) continue;
      const token = syl.hyphenated ? `${clean}-` : clean;
      eventRows.push({
        tick: syl.tick,
        order: 2,
        text: `  ${syl.tick} = E "lyric ${token}"`,
      });
    }
    eventRows.push({
      tick: Math.max(phrase.startTick + 12, phrase.endTick),
      order: 3,
      text: `  ${Math.max(phrase.startTick + 12, phrase.endTick)} = E "phrase_end"`,
    });
  }

  eventRows.sort((a, b) => (a.tick !== b.tick ? a.tick - b.tick : a.order - b.order));
  for (const r of eventRows) out.push(r.text);
  out.push('}');

  // 5-Fret Single Guitar sections
  const fiveFretSectionMap: Record<Difficulty, string> = {
    Expert: 'ExpertSingle',
    Hard: 'HardSingle',
    Medium: 'MediumSingle',
    Easy: 'EasySingle',
  };

  for (const diff of [...DIFFICULTIES].reverse()) {
    const track = tracks.fiveFret[diff];
    if (track && track.notes.length > 0) {
      out.push(
        serializeNoteTrackSection(fiveFretSectionMap[diff], track.notes, track.starPower, FIVE_FRET_TO_CHART_LANE)
      );
    }
  }

  // 6-Fret GHL Guitar sections
  const ghlSectionMap: Record<Difficulty, string> = {
    Expert: 'ExpertGHLGuitar',
    Hard: 'HardGHLGuitar',
    Medium: 'MediumGHLGuitar',
    Easy: 'EasyGHLGuitar',
  };

  for (const diff of [...DIFFICULTIES].reverse()) {
    const track = tracks.ghl[diff];
    if (track && track.notes.length > 0) {
      out.push(
        serializeNoteTrackSection(ghlSectionMap[diff], track.notes, track.starPower, GHL_FRET_TO_CHART_LANE)
      );
    }
  }

  return out.join('\n') + '\n';
}

export function serializeSongIni(
  metadata: SongMetadata,
  durationSec: number,
  hasVideo: boolean
): string {
  const songLengthMs = Math.max(1000, Math.round(durationSec * 1000));
  const lines = [
    '[Song]',
    `name = ${escapeIni(metadata.title || 'Unbenannter Song')}`,
    `artist = ${escapeIni(metadata.artist || 'Unbekannter Interpret')}`,
    `album = ${escapeIni(metadata.album || 'Single')}`,
    `genre = ${escapeIni(metadata.genre || 'Rock')}`,
    `year = ${escapeIni(metadata.year || '2026')}`,
    `charter = ${escapeIni(metadata.charter || 'CloneForge Studio')}`,
    `song_length = ${songLengthMs}`,
    `diff_guitar = ${Math.max(0, Math.min(6, Math.round(metadata.diffGuitar)))}`,
    `diff_guitarghl = ${Math.max(0, Math.min(6, Math.round(metadata.diffGuitarGhl)))}`,
    `diff_bass = -1`,
    `diff_drums = -1`,
    `diff_keys = -1`,
    `diff_vocals = -1`,
    `preview_start_time = ${Math.max(0, Math.round(metadata.previewStartMs))}`,
    `loading_phrase = Generiert mit CloneForge Studio (5-Fret & 6-Fret GHL)`,
  ];

  if (hasVideo && metadata.includeVideo) {
    lines.push('video_start_time = 0');
  }

  return lines.join('\n') + '\n';
}

/**
 * Encodes a Web Audio AudioBuffer into a standard 16-bit PCM WAV byte array
 * so extracted MP4 audio tracks or generated demos play natively in Clone Hero.
 */
export function encodeAudioBufferToWav(buffer: AudioBuffer): Uint8Array {
  const numChannels = Math.min(2, buffer.numberOfChannels);
  const sampleRate = buffer.sampleRate;
  const numFrames = buffer.length;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = numFrames * blockAlign;
  const arrayBuffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(arrayBuffer);

  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) {
      view.setUint8(offset + i, s.charCodeAt(i));
    }
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  const channels: Float32Array[] = [];
  for (let c = 0; c < numChannels; c++) {
    channels.push(buffer.getChannelData(c));
  }

  let offset = 44;
  for (let i = 0; i < numFrames; i++) {
    for (let c = 0; c < numChannels; c++) {
      const clamped = Math.max(-1, Math.min(1, channels[c][i]));
      view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
      offset += 2;
    }
  }

  return new Uint8Array(arrayBuffer);
}

export function getFretDisplayLabel(fret: AnyFretId): string {
  switch (fret) {
    case 'G':
      return 'Grün (1)';
    case 'R':
      return 'Rot (2)';
    case 'Y':
      return 'Gelb (3)';
    case 'B':
      return 'Blau (4)';
    case 'O':
      return 'Orange (5)';
    case 'W1':
      return 'White 1';
    case 'W2':
      return 'White 2';
    case 'W3':
      return 'White 3';
    case 'B1':
      return 'Black 1';
    case 'B2':
      return 'Black 2';
    case 'B3':
      return 'Black 3';
    case 'OPEN':
      return 'Open';
  }
}
