import React, {useRef, useState} from 'react';
import {
  Disc3,
  Download,
  FileAudio,
  Film,
  Image as ImageIcon,
  Loader2,
  Music,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Sparkles,
  Upload,
} from 'lucide-react';
import type {
  AudioAnalysisResult,
  BpmMarker,
  ChartTracks,
  Difficulty,
  InstrumentMode,
  MusicBrainzResult,
  SongMetadata,
} from '../types/chart';
import {getUniqueNoteCount} from '../utils/chartGenerator';
import {DIFFICULTIES, DIFFICULTY_LABELS} from '../utils/difficultyPresets';
import {formatTimecode} from '../utils/timing';

interface AnalysisAndTagsViewProps {
  hasAudio: boolean;
  isDecoding: boolean;
  decodeError: string | null;
  sourceFileName: string | null;
  hasVideo: boolean;
  analysis: AudioAnalysisResult | null;
  bpmMarkers: BpmMarker[];
  offsetMs: number;
  metadata: SongMetadata;
  tracks: ChartTracks;
  mbResults: MusicBrainzResult[];
  autoPipeline: {running: boolean; mbSummary: string | null; lyricsSummary: string | null};
  onSetMbResults: (results: MusicBrainzResult[]) => void;
  onRunAutoPipeline: () => void;
  onFileSelected: (file: File) => void;
  onLoadDemoSong: () => void;
  onUpdateBpm: (newBpm: number) => void;
  onUpdateOffsetMs: (newOffsetMs: number) => void;
  onUpdateMetadata: (patch: Partial<SongMetadata>) => void;
  onOpenInEditor: (mode: InstrumentMode, difficulty: Difficulty) => void;
  onRegenerateAll: () => void;
}

export const AnalysisAndTagsView: React.FC<AnalysisAndTagsViewProps> = ({
  hasAudio,
  isDecoding,
  decodeError,
  sourceFileName,
  hasVideo,
  analysis,
  bpmMarkers,
  offsetMs,
  metadata,
  tracks,
  mbResults,
  autoPipeline,
  onSetMbResults,
  onRunAutoPipeline,
  onFileSelected,
  onLoadDemoSong,
  onUpdateBpm,
  onUpdateOffsetMs,
  onUpdateMetadata,
  onOpenInEditor,
  onRegenerateAll,
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const coverInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  // Tap tempo state
  const tapTimesRef = useRef<number[]>([]);

  // MusicBrainz search state
  const [mbQuery, setMbQuery] = useState('');
  const [mbLoading, setMbLoading] = useState(false);
  const [mbError, setMbError] = useState<string | null>(null);
  const [coverLoadingId, setCoverLoadingId] = useState<string | null>(null);
  const [fallbackCoverUrl, setFallbackCoverUrl] = useState<string | null>(null);

  const currentBpm = bpmMarkers[0]?.bpm ?? analysis?.bpm ?? 120;

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) onFileSelected(file);
  };

  const handleTapTempo = () => {
    const now = performance.now();
    const recent = tapTimesRef.current.filter((t) => now - t < 2500);
    recent.push(now);
    tapTimesRef.current = recent;
    if (recent.length >= 3) {
      const diffs: number[] = [];
      for (let i = 1; i < recent.length; i++) {
        diffs.push(recent[i] - recent[i - 1]);
      }
      const avgMs = diffs.reduce((a, b) => a + b, 0) / diffs.length;
      const tapped = Math.round(Math.min(240, Math.max(50, 60000 / avgMs)));
      onUpdateBpm(tapped);
    }
  };

  const handleMusicBrainzSearch = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const cleanArtist =
      metadata.artist && metadata.artist !== 'Unbekannter Interpret' ? metadata.artist.trim() : '';
    const queryText = mbQuery.trim() || [cleanArtist, metadata.title].filter(Boolean).join(' ');
    if (!queryText) {
      setMbError('Bitte Titel oder Interpret für die MusicBrainz-Suche eingeben.');
      return;
    }

    setMbLoading(true);
    setMbError(null);
    try {
      const params = new URLSearchParams();
      if (!mbQuery.trim() && metadata.title) {
        params.set('title', metadata.title);
        if (cleanArtist) params.set('artist', cleanArtist);
      } else {
        params.set('q', queryText);
      }
      if (analysis?.durationSec) {
        params.set('durationSec', String(Math.round(analysis.durationSec)));
      }
      if (analysis?.activeDurationSec) {
        params.set('activeDurationSec', String(Math.round(analysis.activeDurationSec)));
      }
      params.set('enrich', '1');
      const res = await fetch(`/api/musicbrainz/search?${params.toString()}`);
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'MusicBrainz-Suche fehlgeschlagen.');
      }
      if (data.fallbackCoverUrl) {
        setFallbackCoverUrl(data.fallbackCoverUrl);
      }
      if (data.isrc && !metadata.isrc) {
        onUpdateMetadata({isrc: data.isrc});
      }
      onSetMbResults(Array.isArray(data.results) ? data.results : []);
      if (Array.isArray(data.results) && data.results.length === 0) {
        setMbError('Keine passenden Treffer auf MusicBrainz gefunden.');
      }
    } catch (err) {
      setMbError(err instanceof Error ? err.message : 'Unbekannter Fehler bei MusicBrainz.');
    } finally {
      setMbLoading(false);
    }
  };

  const handleApplyMusicBrainz = async (rec: MusicBrainzResult, releaseIdOverride?: string) => {
    const chosenRelease =
      rec.releases.find((r) => r.id === releaseIdOverride) || rec.releases[0] || null;
    const yearMatch = (chosenRelease?.date || rec.year || '').match(/\d{4}/);

    onUpdateMetadata({
      title: rec.title || metadata.title,
      artist: rec.artist || metadata.artist,
      album: chosenRelease?.title || rec.album || metadata.album,
      year: yearMatch ? yearMatch[0] : metadata.year,
      genre: rec.genre || metadata.genre,
      mbid: rec.mbid,
      releaseMbid: chosenRelease?.id || rec.releaseMbid || null,
    });

    const candidateIds = Array.from(
      new Set(
        [
          chosenRelease?.id,
          rec.releaseMbid,
          ...rec.releases.slice(0, 3).map((r) => r.id),
        ].filter((id): id is string => Boolean(id))
      )
    );

    if (candidateIds.length > 0 || fallbackCoverUrl) {
      setCoverLoadingId(rec.mbid);
      try {
        let found = false;
        for (const relId of candidateIds) {
          const fbParam = fallbackCoverUrl
            ? `?fallbackUrl=${encodeURIComponent(fallbackCoverUrl)}`
            : '';
          const res = await fetch(`/api/musicbrainz/cover/${relId}${fbParam}`);
          if (res.ok) {
            const data = await res.json();
            if (data.dataUrl) {
              onUpdateMetadata({
                coverDataUrl: data.dataUrl,
                coverMime: data.mimeType || 'image/jpeg',
              });
              found = true;
              break;
            }
          }
        }
        if (!found && fallbackCoverUrl) {
          const res = await fetch(
            `/api/musicbrainz/cover/fallback?fallbackUrl=${encodeURIComponent(fallbackCoverUrl)}`
          );
          if (res.ok) {
            const data = await res.json();
            if (data.dataUrl) {
              onUpdateMetadata({
                coverDataUrl: data.dataUrl,
                coverMime: data.mimeType || 'image/jpeg',
              });
            }
          }
        }
      } catch {
        // Cover is optional; metadata already applied
      } finally {
        setCoverLoadingId(null);
      }
    }
  };

  const handleCoverUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        onUpdateMetadata({
          coverDataUrl: reader.result,
          coverMime: file.type || 'image/jpeg',
        });
      }
    };
    reader.readAsDataURL(file);
  };

  return (
    <div className="mx-auto max-w-[1380px] space-y-6 px-6 py-6">
      {(hasAudio || autoPipeline.running || autoPipeline.mbSummary || autoPipeline.lyricsSummary) && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#263145] bg-[#131924] px-5 py-3">
          <div className="flex flex-wrap items-center gap-3 text-xs text-slate-200">
            {autoPipeline.running && <Loader2 className="h-4 w-4 animate-spin text-amber-400" />}
            <span className="font-semibold text-amber-400">Audio-ID & Auto-Tagging:</span>
            {metadata.audioId && (
              <span className="font-mono-tabular text-slate-300">
                ID {metadata.audioId.slice(0, 17)}
                {metadata.isrc ? ` · ISRC ${metadata.isrc}` : ''}
              </span>
            )}
            {autoPipeline.mbSummary && <span>{autoPipeline.mbSummary}</span>}
            {autoPipeline.mbSummary && autoPipeline.lyricsSummary && (
              <span aria-hidden="true" className="text-slate-500">
                ·
              </span>
            )}
            {autoPipeline.lyricsSummary && <span>{autoPipeline.lyricsSummary}</span>}
          </div>
          {hasAudio && !autoPipeline.running && (
            <button
              type="button"
              onClick={onRunAutoPipeline}
              className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border border-[#334155] bg-[#1B2332] px-3 py-1.5 text-xs font-medium text-slate-200 hover:border-amber-500/60 hover:text-white"
            >
              <RefreshCw className="h-3.5 w-3.5 text-amber-400" />
              Über Audio-ID & MusicBrainz neu abgleichen
            </button>
          )}
        </div>
      )}

      {/* Row 1: Media Dropzone + DSP Beat & Timing Summary */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        {/* Dropzone */}
        <section className="rounded-xl border border-[#263145] bg-[#131924] p-5 lg:col-span-5">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h2 className="font-display text-lg font-semibold text-slate-100">
                Audio- oder Video-Quelle
              </h2>
              <p className="mt-0.5 text-sm text-slate-400">
                MP3, MP4, WAV oder OGG per Drag-and-Drop hineinziehen.
              </p>
            </div>
            <button
              type="button"
              onClick={onLoadDemoSong}
              disabled={isDecoding}
              className="inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-lg border border-[#334155] bg-[#1B2332] px-3.5 py-2 text-xs font-medium text-slate-200 transition-colors hover:border-amber-500/60 hover:text-white focus-visible:outline-2 focus-visible:outline-amber-500 disabled:opacity-50"
            >
              <Sparkles className="h-3.5 w-3.5 text-amber-400" />
              Demo-Song laden
            </button>
          </div>

          <div
            onDragOver={(e) => {
              e.preventDefault();
              setIsDragging(true);
            }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={handleDrop}
            className={`mt-4 flex flex-col items-center justify-center rounded-lg border border-dashed px-5 py-7 text-center transition-colors ${
              isDragging
                ? 'border-amber-400 bg-amber-500/10'
                : 'border-[#334155] bg-[#0B0F17]/60 hover:border-slate-500'
            }`}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept="audio/*,video/mp4,.mp3,.mp4,.wav,.ogg,.m4a"
              className="sr-only"
              aria-label="MP3 oder MP4 Datei auswählen"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) onFileSelected(f);
              }}
            />

            {isDecoding ? (
              <div className="flex flex-col items-center gap-2.5">
                <Loader2 className="h-7 w-7 animate-spin text-amber-400" />
                <p className="text-sm font-medium text-slate-200">
                  Audiospur wird dekodiert und spektral analysiert...
                </p>
              </div>
            ) : (
              <>
                <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-[#1B2332] text-amber-400">
                  {hasVideo ? <Film className="h-5 w-5" /> : <Upload className="h-5 w-5" />}
                </div>
                <p className="mt-3 text-sm font-medium text-slate-200">
                  {sourceFileName ? sourceFileName : 'MP4 / MP3 hier ablegen'}
                </p>
                <p className="mt-1 text-xs text-slate-400">
                  {hasAudio && analysis
                    ? `Dauer ${formatTimecode(analysis.durationSec)} · ${analysis.onsets.length} erkannte Transienten${hasVideo ? ' · MP4-Video bereit' : ''}`
                    : 'Audiospur wird direkt im Browser für 5-Fret & 6-Fret GHL analysiert'}
                </p>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="mt-4 inline-flex items-center gap-2 whitespace-nowrap rounded-lg bg-amber-500 px-4 py-2 text-xs font-semibold text-slate-950 transition-colors hover:bg-amber-400 focus-visible:outline-2 focus-visible:outline-amber-400"
                >
                  <FileAudio className="h-4 w-4" />
                  Datei auswählen
                </button>
              </>
            )}
          </div>

          {decodeError && (
            <p role="alert" className="mt-3 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300">
              {decodeError}
            </p>
          )}
        </section>

        {/* Waveform + Tempo / Offset Calibration */}
        <section className="flex flex-col justify-between rounded-xl border border-[#263145] bg-[#131924] p-5 lg:col-span-7">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="font-display text-lg font-semibold text-slate-100">
                Wellenform, Tempo & Beat-Raster
              </h2>
              <p className="mt-0.5 text-sm text-slate-400">
                Automatisch erkannte BPM und Offset-Kalibrierung für taktgenaues Charting.
              </p>
            </div>
            {hasAudio && (
              <button
                type="button"
                onClick={onRegenerateAll}
                className="inline-flex items-center gap-2 whitespace-nowrap rounded-lg border border-[#334155] bg-[#1B2332] px-3.5 py-2 text-xs font-medium text-slate-200 transition-colors hover:border-amber-500/60 hover:text-white"
              >
                <RefreshCw className="h-3.5 w-3.5 text-amber-400" />
                Alle 8 Spuren neu berechnen
              </button>
            )}
          </div>

          {/* Waveform Bars */}
          <div className="my-4 flex h-24 items-center gap-[1px] overflow-hidden rounded-lg border border-[#263145] bg-[#0B0F17] px-2">
            {analysis && analysis.waveformPeaks.length > 0 ? (
              analysis.waveformPeaks.slice(0, 180).map((peak, i) => {
                // Sample evenly across 900 peaks
                const idx = Math.min(analysis.waveformPeaks.length - 1, Math.floor((i / 180) * analysis.waveformPeaks.length));
                const amp = analysis.waveformPeaks[idx];
                const heightPct = Math.max(8, Math.round(amp * 88));
                return (
                  <div
                    key={i}
                    className="flex-1 rounded-xs bg-amber-500/75"
                    style={{height: `${heightPct}%`}}
                  />
                );
              })
            ) : (
              <div className="flex w-full items-center justify-center text-xs text-slate-500">
                Noch keine Audiodatei geladen — ziehe eine MP3/MP4 hinein oder starte den Demo-Song.
              </div>
            )}
          </div>

          {/* BPM & Offset Controls */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div className="rounded-lg border border-[#263145] bg-[#0B0F17]/70 p-3">
              <label htmlFor="bpm-input" className="block text-xs font-medium text-slate-400">
                Erkannte BPM
              </label>
              <div className="mt-1.5 flex items-center gap-2">
                <input
                  id="bpm-input"
                  type="number"
                  min={40}
                  max={280}
                  step={0.1}
                  value={currentBpm}
                  disabled={!hasAudio}
                  onChange={(e) => {
                    const val = Number(e.target.value);
                    if (val >= 40 && val <= 280) onUpdateBpm(val);
                  }}
                  className="font-mono-tabular w-20 rounded-md border border-[#334155] bg-[#131924] px-2.5 py-1.5 text-sm font-semibold text-slate-100 focus:border-amber-500 focus:outline-none disabled:opacity-50"
                />
                <button
                  type="button"
                  disabled={!hasAudio}
                  onClick={() => onUpdateBpm(Math.max(40, Math.round(currentBpm / 2)))}
                  className="rounded-md border border-[#334155] bg-[#1B2332] px-2 py-1.5 text-xs font-medium text-slate-300 hover:text-white disabled:opacity-50"
                  title="BPM halbieren"
                >
                  ÷2
                </button>
                <button
                  type="button"
                  disabled={!hasAudio}
                  onClick={() => onUpdateBpm(Math.min(280, Math.round(currentBpm * 2)))}
                  className="rounded-md border border-[#334155] bg-[#1B2332] px-2 py-1.5 text-xs font-medium text-slate-300 hover:text-white disabled:opacity-50"
                  title="BPM verdoppeln"
                >
                  ×2
                </button>
                <button
                  type="button"
                  disabled={!hasAudio}
                  onClick={handleTapTempo}
                  className="rounded-md border border-[#334155] bg-[#1B2332] px-2.5 py-1.5 text-xs font-medium text-amber-400 hover:border-amber-500/60 disabled:opacity-50"
                >
                  Tap
                </button>
              </div>
              {bpmMarkers.length > 1 && (
                <p className="mt-1 text-[11px] text-amber-400/90">
                  {bpmMarkers.length} Tempo-Marker erkannt (automatisches Drift-Tracking)
                </p>
              )}
            </div>

            <div className="rounded-lg border border-[#263145] bg-[#0B0F17]/70 p-3">
              <label htmlFor="offset-input" className="block text-xs font-medium text-slate-400">
                Beat-Offset (ms)
              </label>
              <div className="mt-1.5 flex items-center gap-2">
                <input
                  id="offset-input"
                  type="number"
                  min={-30000}
                  max={30000}
                  step={5}
                  value={offsetMs}
                  disabled={!hasAudio}
                  onChange={(e) => onUpdateOffsetMs(Number(e.target.value) || 0)}
                  className="font-mono-tabular w-24 rounded-md border border-[#334155] bg-[#131924] px-2.5 py-1.5 text-sm font-semibold text-slate-100 focus:border-amber-500 focus:outline-none disabled:opacity-50"
                />
                <span className="text-xs text-slate-400">ms</span>
              </div>
            </div>

            <div className="rounded-lg border border-[#263145] bg-[#0B0F17]/70 p-3">
              <span className="block text-xs font-medium text-slate-400">
                Schwierigkeitsstufen
              </span>
              <div className="font-mono-tabular mt-2 text-sm font-semibold text-slate-100">
                4× 5-Fret · 4× 6-Fret GHL
              </div>
              <p className="mt-0.5 text-xs text-slate-400">
                Alle 8 Tracks bereit für Clone Hero
              </p>
            </div>
          </div>
        </section>
      </div>

      {/* Row 2: Generated Tracks Matrix (5-Fret & 6-Fret GHL side by side) */}
      <section className="rounded-xl border border-[#263145] bg-[#131924] p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-display text-lg font-semibold text-slate-100">
              Generierte Schwierigkeitsgrade (5-Fret & 6-Bund GHL)
            </h2>
            <p className="mt-0.5 text-sm text-slate-400">
              Vollständige automatische Generierung für klassische 5-Fret- und Guitar-Hero-Live-6-Bund-Gitarre.
            </p>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-1 gap-6 lg:grid-cols-2">
          {/* 6-Fret GHL Table */}
          <div className="rounded-lg border border-[#263145] bg-[#0B0F17]/60 p-4">
            <div className="mb-3 flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold text-slate-100">
                  6-Bund Guitar Hero Live (GHLGuitar)
                </h3>
                <p className="text-xs text-slate-400">
                  3×2 Black/White-Frets · Barre- & Diagonal-Akkorde · Open-Strums
                </p>
              </div>
              <span className="font-mono-tabular text-xs text-amber-400">
                diff_guitarghl = {metadata.diffGuitarGhl}
              </span>
            </div>

            <div className="divide-y divide-[#1E293B]">
              {DIFFICULTIES.map((diff) => {
                const track = tracks.ghl[diff];
                const noteCount = getUniqueNoteCount(track.notes);
                const openCount = track.notes.filter((n) => n.fret === 'OPEN').length;
                return (
                  <div key={`ghl-${diff}`} className="flex items-center justify-between py-2.5">
                    <div>
                      <span className="text-sm font-medium text-slate-200">{DIFFICULTY_LABELS[diff]}</span>
                      <div className="font-mono-tabular text-xs text-slate-400">
                        {noteCount} Anschläge · {track.starPower.length} Star Power · {openCount} Open
                      </div>
                    </div>
                    <button
                      type="button"
                      disabled={!hasAudio}
                      onClick={() => onOpenInEditor('ghl', diff)}
                      className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border border-[#334155] bg-[#1B2332] px-3 py-1.5 text-xs font-medium text-slate-200 transition-colors hover:border-amber-500/70 hover:text-white disabled:opacity-40"
                    >
                      <SlidersHorizontal className="h-3.5 w-3.5 text-amber-400" />
                      Im GHL-Editor öffnen
                    </button>
                  </div>
                );
              })}
            </div>
          </div>

          {/* 5-Fret Standard Table */}
          <div className="rounded-lg border border-[#263145] bg-[#0B0F17]/60 p-4">
            <div className="mb-3 flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold text-slate-100">
                  5-Fret Standard Guitar (Single)
                </h3>
                <p className="text-xs text-slate-400">
                  GRYBO 5-Bund-Spur · Akkorde · HOPO & Tap-Läufe
                </p>
              </div>
              <span className="font-mono-tabular text-xs text-amber-400">
                diff_guitar = {metadata.diffGuitar}
              </span>
            </div>

            <div className="divide-y divide-[#1E293B]">
              {DIFFICULTIES.map((diff) => {
                const track = tracks.fiveFret[diff];
                const noteCount = getUniqueNoteCount(track.notes);
                const hopoCount = track.notes.filter((n) => n.forced || n.tap).length;
                return (
                  <div key={`5f-${diff}`} className="flex items-center justify-between py-2.5">
                    <div>
                      <span className="text-sm font-medium text-slate-200">{DIFFICULTY_LABELS[diff]}</span>
                      <div className="font-mono-tabular text-xs text-slate-400">
                        {noteCount} Anschläge · {track.starPower.length} Star Power · {hopoCount} HOPO/Tap
                      </div>
                    </div>
                    <button
                      type="button"
                      disabled={!hasAudio}
                      onClick={() => onOpenInEditor('5fret', diff)}
                      className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border border-[#334155] bg-[#1B2332] px-3 py-1.5 text-xs font-medium text-slate-200 transition-colors hover:border-amber-500/70 hover:text-white disabled:opacity-40"
                    >
                      <SlidersHorizontal className="h-3.5 w-3.5 text-amber-400" />
                      Im 5-Fret-Editor öffnen
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </section>

      {/* Row 3: MusicBrainz Tagging + song.ini Metadata */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        {/* MusicBrainz Lookup */}
        <section className="rounded-xl border border-[#263145] bg-[#131924] p-5 lg:col-span-6">
          <div className="flex items-center justify-between gap-2">
            <div>
              <h2 className="font-display text-lg font-semibold text-slate-100">
                MusicBrainz-Tagging & Cover Art
              </h2>
              <p className="mt-0.5 text-sm text-slate-400">
                Metadaten und offizielles Album-Cover direkt über MusicBrainz abrufen.
              </p>
            </div>
            <Disc3 className="h-5 w-5 text-slate-400" />
          </div>

          <form onSubmit={handleMusicBrainzSearch} className="mt-4 flex gap-2">
            <label htmlFor="mb-search-input" className="sr-only">
              MusicBrainz Suche
            </label>
            <input
              id="mb-search-input"
              type="text"
              value={mbQuery}
              onChange={(e) => setMbQuery(e.target.value)}
              placeholder={
                [metadata.artist, metadata.title].filter(Boolean).join(' - ') ||
                'Interpret oder Songtitel suchen...'
              }
              className="min-w-0 flex-1 rounded-lg border border-[#334155] bg-[#0B0F17] px-3.5 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-amber-500 focus:outline-none"
            />
            <button
              type="submit"
              disabled={mbLoading}
              className="inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-lg bg-amber-500 px-4 py-2 text-xs font-semibold text-slate-950 transition-colors hover:bg-amber-400 disabled:opacity-50"
            >
              {mbLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
              Suchen
            </button>
          </form>

          {mbError && (
            <p role="alert" className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
              {mbError}
            </p>
          )}

          <div className="mt-4 max-h-72 space-y-2 overflow-y-auto pr-1">
            {mbLoading ? (
              <div className="space-y-2">
                {[0, 1, 2].map((idx) => (
                  <div key={idx} className="h-14 animate-pulse rounded-lg border border-[#263145] bg-[#0B0F17]/60" />
                ))}
              </div>
            ) : mbResults.length > 0 ? (
              mbResults.map((rec) => (
                <div
                  key={rec.mbid}
                  className="flex items-center justify-between gap-3 rounded-lg border border-[#263145] bg-[#0B0F17]/70 px-3.5 py-2.5"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-slate-100">{rec.title}</div>
                    <div className="truncate text-xs text-slate-400">
                      {rec.artist || 'Unbekannt'}
                      {rec.album ? ` · ${rec.album}` : ''}
                      {rec.year ? ` · ${rec.year}` : ''}
                      {rec.genre ? ` · ${rec.genre}` : ''}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleApplyMusicBrainz(rec)}
                    disabled={coverLoadingId === rec.mbid}
                    className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-[#334155] bg-[#1B2332] px-3 py-1.5 text-xs font-medium text-amber-400 transition-colors hover:border-amber-500/60 hover:text-amber-300"
                  >
                    {coverLoadingId === rec.mbid ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Download className="h-3.5 w-3.5" />
                    )}
                    Übernehmen
                  </button>
                </div>
              ))
            ) : (
              <div className="rounded-lg border border-[#263145] bg-[#0B0F17]/40 px-4 py-6 text-center text-xs text-slate-400">
                Suche nach einem Song, um Titel, Interpret, Album, Jahr, Genre und Cover automatisch zu vervollständigen.
              </div>
            )}
          </div>
        </section>

        {/* Editable song.ini Form + Cover Art */}
        <section className="rounded-xl border border-[#263145] bg-[#131924] p-5 lg:col-span-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="font-display text-lg font-semibold text-slate-100">
                Clone Hero Metadaten (song.ini)
              </h2>
              <p className="mt-0.5 text-sm text-slate-400">
                Feinanpassung aller Tags für die Clone-Hero-Songbibliothek.
              </p>
            </div>

            {/* Cover Preview / Upload */}
            <div className="flex items-center gap-3">
              <div className="relative h-16 w-16 shrink-0 overflow-hidden rounded-lg border border-[#334155] bg-[#0B0F17]">
                {metadata.coverDataUrl ? (
                  <img
                    src={metadata.coverDataUrl}
                    alt="Album Cover"
                    referrerPolicy="no-referrer"
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center text-slate-500">
                    <Music className="h-6 w-6" />
                  </div>
                )}
              </div>
              <div>
                <input
                  ref={coverInputRef}
                  type="file"
                  accept="image/*"
                  className="sr-only"
                  aria-label="Album Cover hochladen"
                  onChange={handleCoverUpload}
                />
                <button
                  type="button"
                  onClick={() => coverInputRef.current?.click()}
                  className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border border-[#334155] bg-[#1B2332] px-2.5 py-1.5 text-xs font-medium text-slate-200 hover:border-amber-500/60"
                >
                  <ImageIcon className="h-3.5 w-3.5 text-amber-400" />
                  Cover wählen
                </button>
              </div>
            </div>
          </div>

          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="meta-title" className="block text-xs font-medium text-slate-400">
                Song-Titel
              </label>
              <input
                id="meta-title"
                type="text"
                value={metadata.title}
                onChange={(e) => onUpdateMetadata({title: e.target.value})}
                className="mt-1 w-full rounded-lg border border-[#334155] bg-[#0B0F17] px-3 py-2 text-sm text-slate-100 focus:border-amber-500 focus:outline-none"
              />
            </div>
            <div>
              <label htmlFor="meta-artist" className="block text-xs font-medium text-slate-400">
                Interpret
              </label>
              <input
                id="meta-artist"
                type="text"
                value={metadata.artist}
                onChange={(e) => onUpdateMetadata({artist: e.target.value})}
                className="mt-1 w-full rounded-lg border border-[#334155] bg-[#0B0F17] px-3 py-2 text-sm text-slate-100 focus:border-amber-500 focus:outline-none"
              />
            </div>
            <div>
              <label htmlFor="meta-album" className="block text-xs font-medium text-slate-400">
                Album
              </label>
              <input
                id="meta-album"
                type="text"
                value={metadata.album}
                onChange={(e) => onUpdateMetadata({album: e.target.value})}
                className="mt-1 w-full rounded-lg border border-[#334155] bg-[#0B0F17] px-3 py-2 text-sm text-slate-100 focus:border-amber-500 focus:outline-none"
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label htmlFor="meta-year" className="block text-xs font-medium text-slate-400">
                  Jahr
                </label>
                <input
                  id="meta-year"
                  type="text"
                  value={metadata.year}
                  onChange={(e) => onUpdateMetadata({year: e.target.value})}
                  className="font-mono-tabular mt-1 w-full rounded-lg border border-[#334155] bg-[#0B0F17] px-3 py-2 text-sm text-slate-100 focus:border-amber-500 focus:outline-none"
                />
              </div>
              <div>
                <label htmlFor="meta-genre" className="block text-xs font-medium text-slate-400">
                  Genre
                </label>
                <input
                  id="meta-genre"
                  type="text"
                  value={metadata.genre}
                  onChange={(e) => onUpdateMetadata({genre: e.target.value})}
                  className="mt-1 w-full rounded-lg border border-[#334155] bg-[#0B0F17] px-3 py-2 text-sm text-slate-100 focus:border-amber-500 focus:outline-none"
                />
              </div>
            </div>
            <div>
              <label htmlFor="meta-charter" className="block text-xs font-medium text-slate-400">
                Charter
              </label>
              <input
                id="meta-charter"
                type="text"
                value={metadata.charter}
                onChange={(e) => onUpdateMetadata({charter: e.target.value})}
                className="mt-1 w-full rounded-lg border border-[#334155] bg-[#0B0F17] px-3 py-2 text-sm text-slate-100 focus:border-amber-500 focus:outline-none"
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label htmlFor="meta-diff-5f" className="block text-xs font-medium text-slate-400">
                  5-Fret Tier (0–6)
                </label>
                <input
                  id="meta-diff-5f"
                  type="number"
                  min={0}
                  max={6}
                  value={metadata.diffGuitar}
                  onChange={(e) => onUpdateMetadata({diffGuitar: Number(e.target.value) || 0})}
                  className="font-mono-tabular mt-1 w-full rounded-lg border border-[#334155] bg-[#0B0F17] px-3 py-2 text-sm text-slate-100 focus:border-amber-500 focus:outline-none"
                />
              </div>
              <div>
                <label htmlFor="meta-diff-ghl" className="block text-xs font-medium text-slate-400">
                  6-Bund GHL Tier (0–6)
                </label>
                <input
                  id="meta-diff-ghl"
                  type="number"
                  min={0}
                  max={6}
                  value={metadata.diffGuitarGhl}
                  onChange={(e) => onUpdateMetadata({diffGuitarGhl: Number(e.target.value) || 0})}
                  className="font-mono-tabular mt-1 w-full rounded-lg border border-[#334155] bg-[#0B0F17] px-3 py-2 text-sm text-slate-100 focus:border-amber-500 focus:outline-none"
                />
              </div>
            </div>
          </div>

          {hasVideo && (
            <label className="mt-4 flex cursor-pointer items-center gap-2.5 text-sm text-slate-300">
              <input
                type="checkbox"
                checked={metadata.includeVideo}
                onChange={(e) => onUpdateMetadata({includeVideo: e.target.checked})}
                className="h-4 w-4 rounded border-slate-600 bg-[#0B0F17] accent-amber-500"
              />
              Originales MP4-Video als Hintergrundvideo (video.mp4) in den ZIP-Export einbinden
            </label>
          )}
        </section>
      </div>
    </div>
  );
};
