export type Difficulty = 'Easy' | 'Medium' | 'Hard' | 'Expert';
export type InstrumentMode = '5fret' | 'ghl';

export type FiveFretId = 'G' | 'R' | 'Y' | 'B' | 'O' | 'OPEN';
export type GhlFretId = 'W1' | 'W2' | 'W3' | 'B1' | 'B2' | 'B3' | 'OPEN';
export type AnyFretId = FiveFretId | GhlFretId;

export type QuantizeGrid = 4 | 8 | 12 | 16 | 24 | 32;

export interface ChartNote {
  id: string;
  tick: number;
  fret: AnyFretId;
  sustain: number; // in ticks (0 = tap/strum without sustain tail)
  forced: boolean;
  tap: boolean;
}

export interface StarPowerPhrase {
  id: string;
  tick: number;
  duration: number; // in ticks
}

export interface BpmMarker {
  tick: number;
  bpm: number;
}

export interface TimeSignatureMarker {
  tick: number;
  numerator: number;
  denominator: number; // 4 means quarter note (written as exponent 2 in .chart)
}

export interface ChartSectionMarker {
  tick: number;
  name: string;
}

export interface InstrumentTrack {
  notes: ChartNote[];
  starPower: StarPowerPhrase[];
}

export interface ChartTracks {
  fiveFret: Record<Difficulty, InstrumentTrack>;
  ghl: Record<Difficulty, InstrumentTrack>;
}

export interface DifficultyConfig {
  minSpacingMs: number;
  onsetSensitivity: number; // 0.10 to 0.95
  chordProbability: number; // 0 to 1
  maxChordSize: 1 | 2 | 3;
  openNoteRate: number; // 0 to 0.45
  hopoThresholdMs: number; // 0 to 320
  tapRate: number; // 0 to 0.4
  sustainSensitivity: number; // 0 to 1
  starPowerDensity: number; // 0 to 1
  quantizeGrid: QuantizeGrid;
  // GHL 6-Fret specific ergonomic parameters
  allowWhiteFrets: boolean;
  allowBlackFrets: boolean;
  allowBarreChords: boolean; // Same column: B1+W1, B2+W2, B3+W3
  allowDiagonalChords: boolean; // Adjacent column cross-row: W1+B2, B1+W2, W2+B3, B2+W3
  rowSwitchPenalty: number; // 0 to 1 (higher = smoother row continuity for lower difficulties)
}

export type DifficultyConfigMap = {
  fiveFret: Record<Difficulty, DifficultyConfig>;
  ghl: Record<Difficulty, DifficultyConfig>;
};

export interface LyricSyllable {
  id: string;
  tick: number;
  text: string;
  hyphenated: boolean;
}

export interface LyricPhrase {
  id: string;
  startTick: number;
  endTick: number;
  syllables: LyricSyllable[];
}

export interface SongMetadata {
  title: string;
  artist: string;
  album: string;
  year: string;
  genre: string;
  charter: string;
  diffGuitar: number; // 0..6
  diffGuitarGhl: number; // 0..6
  previewStartMs: number;
  includeVideo: boolean;
  coverDataUrl: string | null;
  coverMime: string | null;
  mbid: string | null;
  releaseMbid: string | null;
  isrc?: string | null;
  audioId?: string | null;
}

export interface DetectedOnset {
  timeSec: number;
  strength: number; // 0..1 normalized
  centroid: number; // 0..1 normalized spectral brightness / pitch proxy
  lowEnergy: number; // 0..1 bass/kick energy
  midEnergy: number; // 0..1 guitar/vocal energy
  highEnergy: number; // 0..1 hi-hat/attack energy
  sustainSec: number; // estimated energy tail length
}

export interface AudioAnalysisResult {
  bpm: number;
  bpmMarkers?: BpmMarker[];
  offsetMs: number;
  durationSec: number;
  activeDurationSec?: number;
  musicStartSec?: number;
  audioId?: string;
  sections?: ChartSectionMarker[];
  sampleRate: number;
  waveformPeaks: number[]; // ~800 normalized buckets for timeline overview
  onsets: DetectedOnset[];
}

export interface MusicBrainzReleaseInfo {
  id: string;
  title: string;
  date: string;
  country: string;
  status: string;
  trackCount: number;
}

export interface MusicBrainzResult {
  mbid: string;
  title: string;
  artist: string;
  album: string;
  releaseMbid: string;
  year: string;
  genre: string;
  durationMs: number | null;
  score: number;
  releases: MusicBrainzReleaseInfo[];
}

export interface LrcLibResult {
  id: number;
  trackName: string;
  artistName: string;
  albumName: string;
  duration: number;
  instrumental: boolean;
  hasSynced: boolean;
  syncedLyrics: string;
  plainLyrics: string;
}

export type EditorTool = 'select' | 'add' | 'erase' | 'starpower';
