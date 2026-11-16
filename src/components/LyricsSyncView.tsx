import React, {useEffect, useRef, useState} from 'react';
import {
  Clock,
  FileText,
  Loader2,
  Pause,
  Play,
  Plus,
  Search,
  Sparkles,
  Trash2,
  Upload,
} from 'lucide-react';
import type {BpmMarker, LrcLibResult, LyricPhrase, SongMetadata} from '../types/chart';
import {
  formatPhraseText,
  formatPhraseTimestamp,
  lrcLinesToPhrases,
  parseLrcString,
  plainTextToTimedPhrases,
  shiftPhraseTicks,
  tapSyncPhraseToTime,
} from '../utils/lyricsSync';
import {DEFAULT_RESOLUTION, formatTimecode, timeSecToTick} from '../utils/timing';

interface LyricsSyncViewProps {
  hasAudio: boolean;
  isPlaying: boolean;
  currentTimeSec: number;
  durationSec: number;
  bpmMarkers: BpmMarker[];
  offsetMs: number;
  metadata: SongMetadata;
  lyrics: LyricPhrase[];
  lrcResults: LrcLibResult[];
  onSetLrcResults: (results: LrcLibResult[]) => void;
  onTogglePlay: () => void;
  onSeek: (sec: number) => void;
  onSetLyrics: (phrases: LyricPhrase[]) => void;
}

export const LyricsSyncView: React.FC<LyricsSyncViewProps> = ({
  hasAudio,
  isPlaying,
  currentTimeSec,
  durationSec,
  bpmMarkers,
  offsetMs,
  metadata,
  lyrics,
  lrcResults: results,
  onSetLrcResults: setResults,
  onTogglePlay,
  onSeek,
  onSetLyrics,
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [rawText, setRawText] = useState('');
  const [activeTapIdx, setActiveTapIdx] = useState(0);
  const [tapModeActive, setTapModeActive] = useState(false);

  const handleSearchLyrics = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const cleanArtist =
      metadata.artist && metadata.artist !== 'Unbekannter Interpret' ? metadata.artist.trim() : '';
    const q = searchQuery.trim() || [cleanArtist, metadata.title].filter(Boolean).join(' ');
    if (!q) {
      setError('Bitte Songtitel oder Interpret eingeben.');
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (!searchQuery.trim() && metadata.title) {
        params.set('track_name', metadata.title);
        if (cleanArtist) params.set('artist_name', cleanArtist);
      } else {
        params.set('q', q);
      }
      if (durationSec > 0) {
        params.set('durationSec', String(Math.round(durationSec)));
      }

      const res = await fetch(`/api/lyrics/search?${params.toString()}`);
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'LRCLIB-Abfrage fehlgeschlagen.');
      }
      const list = Array.isArray(data.results) ? data.results : [];
      setResults(list);
      if (list.length === 0) {
        setError('Keine passenden Songtexte bei LRCLIB gefunden.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Verbindungsfehler zu LRCLIB.');
    } finally {
      setLoading(false);
    }
  };

  const applyLrcResult = (item: LrcLibResult) => {
    if (item.syncedLyrics) {
      const parsed = parseLrcString(item.syncedLyrics);
      const phrases = lrcLinesToPhrases(
        parsed,
        bpmMarkers,
        DEFAULT_RESOLUTION,
        offsetMs,
        durationSec || 180
      );
      onSetLyrics(phrases);
      setActiveTapIdx(0);
    } else if (item.plainLyrics) {
      const phrases = plainTextToTimedPhrases(
        item.plainLyrics,
        durationSec || 180,
        bpmMarkers,
        DEFAULT_RESOLUTION,
        offsetMs
      );
      onSetLyrics(phrases);
      setActiveTapIdx(0);
    }
  };

  const handleLrcFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    const parsed = parseLrcString(text);
    if (parsed.length > 0) {
      onSetLyrics(
        lrcLinesToPhrases(parsed, bpmMarkers, DEFAULT_RESOLUTION, offsetMs, durationSec || 180)
      );
    } else {
      onSetLyrics(
        plainTextToTimedPhrases(text, durationSec || 180, bpmMarkers, DEFAULT_RESOLUTION, offsetMs)
      );
    }
    setActiveTapIdx(0);
  };

  const handleApplyRawText = () => {
    if (!rawText.trim()) return;
    const parsed = parseLrcString(rawText);
    if (parsed.length > 0) {
      onSetLyrics(
        lrcLinesToPhrases(parsed, bpmMarkers, DEFAULT_RESOLUTION, offsetMs, durationSec || 180)
      );
    } else {
      onSetLyrics(
        plainTextToTimedPhrases(rawText, durationSec || 180, bpmMarkers, DEFAULT_RESOLUTION, offsetMs)
      );
    }
    setActiveTapIdx(0);
  };

  const handleTapSyncCurrent = () => {
    if (lyrics.length === 0) return;
    const idx = Math.min(lyrics.length - 1, Math.max(0, activeTapIdx));
    const updated = lyrics.map((phrase, i) =>
      i === idx
        ? tapSyncPhraseToTime(phrase, currentTimeSec, bpmMarkers, DEFAULT_RESOLUTION, offsetMs)
        : phrase
    );
    onSetLyrics(updated);
    if (idx < lyrics.length - 1) {
      setActiveTapIdx(idx + 1);
    }
  };

  // Spacebar triggers Tap-Sync when tapModeActive is enabled
  useEffect(() => {
    if (!tapModeActive) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      if (e.code === 'Space') {
        e.preventDefault();
        handleTapSyncCurrent();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  const handlePhraseTextChange = (idx: number, newText: string) => {
    const target = lyrics[idx];
    if (!target) return;
    const startSec = formatPhraseTimestamp(target, bpmMarkers, DEFAULT_RESOLUTION, offsetMs);
    const endSec = Math.max(startSec + 1.2, startSec + Math.max(1.2, newText.length * 0.08));
    const rebuilt = lrcLinesToPhrases(
      [{timeSec: startSec, text: newText || '...'}],
      bpmMarkers,
      DEFAULT_RESOLUTION,
      offsetMs,
      Math.max(durationSec || 180, endSec + 1)
    )[0];

    const next = [...lyrics];
    next[idx] = {
      ...rebuilt,
      id: target.id,
      endTick: Math.max(target.startTick + 48, target.endTick),
    };
    onSetLyrics(next);
  };

  const handleNudgePhrase = (idx: number, deltaMs: number) => {
    const bpm = bpmMarkers[0]?.bpm ?? 120;
    const deltaTicks = Math.round(((deltaMs / 1000) * bpm * DEFAULT_RESOLUTION) / 60);
    const next = lyrics.map((p, i) => (i === idx ? shiftPhraseTicks(p, deltaTicks) : p));
    onSetLyrics(next);
  };

  const handleAddPhrase = () => {
    const startSec = Math.max(0, currentTimeSec);
    const created = lrcLinesToPhrases(
      [{timeSec: startSec, text: 'Neue Gesangs-Zeile'}],
      bpmMarkers,
      DEFAULT_RESOLUTION,
      offsetMs,
      Math.max(durationSec || 180, startSec + 3)
    )[0];
    const next = [...lyrics, {...created, id: `phrase-manual-${Date.now()}`}].sort(
      (a, b) => a.startTick - b.startTick
    );
    onSetLyrics(next);
  };

  const handleDeletePhrase = (idx: number) => {
    onSetLyrics(lyrics.filter((_, i) => i !== idx));
  };

  return (
    <div className="mx-auto max-w-[1380px] space-y-6 px-6 py-6">
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        {/* Left: LRCLIB Search & Import */}
        <section className="space-y-5 rounded-xl border border-[#263145] bg-[#131924] p-5 lg:col-span-5">
          <div>
            <h2 className="font-display text-lg font-semibold text-slate-100">
              Songtexte laden (LRCLIB & .LRC)
            </h2>
            <p className="mt-0.5 text-sm text-slate-400">
              Synchronisierte Lyrics abrufen oder als LRC/Text einfügen — wird direkt als Clone-Hero-[Events] exportiert.
            </p>
          </div>

          <form onSubmit={handleSearchLyrics} className="flex gap-2">
            <label htmlFor="lrc-search-input" className="sr-only">
              Songtext bei LRCLIB suchen
            </label>
            <input
              id="lrc-search-input"
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={
                [metadata.artist, metadata.title].filter(Boolean).join(' - ') ||
                'Songtitel oder Interpret...'
              }
              className="min-w-0 flex-1 rounded-lg border border-[#334155] bg-[#0B0F17] px-3.5 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-amber-500 focus:outline-none"
            />
            <button
              type="submit"
              disabled={loading}
              className="inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-lg bg-amber-500 px-4 py-2 text-xs font-semibold text-slate-950 hover:bg-amber-400 disabled:opacity-50"
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
              Suchen
            </button>
          </form>

          {error && (
            <p role="alert" className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
              {error}
            </p>
          )}

          {results.length > 0 && (
            <div className="max-h-56 space-y-2 overflow-y-auto pr-1">
              {results.map((item) => (
                <div
                  key={item.id}
                  className="flex items-center justify-between gap-3 rounded-lg border border-[#263145] bg-[#0B0F17]/70 px-3 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-slate-100">
                      {item.trackName}
                    </div>
                    <div className="truncate text-xs text-slate-400">
                      {item.artistName}
                      {item.albumName ? ` · ${item.albumName}` : ''}
                      {' · '}
                      {item.hasSynced ? 'Synchronisiert (LRC)' : 'Nur Text'}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => applyLrcResult(item)}
                    className="shrink-0 whitespace-nowrap rounded-md border border-[#334155] bg-[#1B2332] px-3 py-1.5 text-xs font-medium text-amber-400 hover:border-amber-500/60"
                  >
                    Laden
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Upload .lrc or paste text */}
          <div className="border-t border-[#263145] pt-4">
            <div className="flex items-center justify-between">
              <label htmlFor="raw-lyrics-textarea" className="text-xs font-semibold text-slate-300">
                Eigener Songtext / LRC-Datei
              </label>
              <div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".lrc,.txt,text/plain"
                  className="sr-only"
                  aria-label="LRC oder Textdatei hochladen"
                  onChange={handleLrcFileUpload}
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-400 hover:text-amber-300"
                >
                  <Upload className="h-3.5 w-3.5" />
                  .lrc / .txt hochladen
                </button>
              </div>
            </div>

            <textarea
              id="raw-lyrics-textarea"
              rows={5}
              value={rawText}
              onChange={(e) => setRawText(e.target.value)}
              placeholder={'[00:08.50] Erste Zeile mit Timecode\nOder einfachen Text zeilenweise einfügen (Silben mit "-" trennen, z.B. Gi-tar-re)'}
              className="mt-2 w-full rounded-lg border border-[#334155] bg-[#0B0F17] px-3 py-2 text-xs text-slate-100 placeholder:text-slate-500 focus:border-amber-500 focus:outline-none"
            />

            <button
              type="button"
              onClick={handleApplyRawText}
              disabled={!rawText.trim()}
              className="mt-2 inline-flex w-full items-center justify-center gap-2 rounded-lg border border-[#334155] bg-[#1B2332] px-4 py-2 text-xs font-semibold text-slate-200 hover:border-amber-500/60 hover:text-white disabled:opacity-40"
            >
              <Sparkles className="h-3.5 w-3.5 text-amber-400" />
              Text in Clone-Hero-Lyrics umwandeln
            </button>
          </div>
        </section>

        {/* Right: Interactive Phrase & Tap-Sync Timeline */}
        <section className="flex flex-col rounded-xl border border-[#263145] bg-[#131924] p-5 lg:col-span-7">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="font-display text-lg font-semibold text-slate-100">
                In-Game Lyrics & Tap-Sync-Timeline
              </h2>
              <p className="mt-0.5 text-sm text-slate-400">
                Jede Zeile erzeugt phrase_start- und Silben-Events (E &quot;lyric ...&quot;) für Clone Hero.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={!hasAudio}
                onClick={onTogglePlay}
                className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg bg-amber-500 px-3.5 py-2 text-xs font-semibold text-slate-950 hover:bg-amber-400 disabled:opacity-40"
              >
                {isPlaying ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
                {isPlaying ? 'Pause' : 'Abspielen'}
              </button>

              <button
                type="button"
                disabled={!hasAudio || lyrics.length === 0}
                onClick={() => setTapModeActive((v) => !v)}
                className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg border px-3 py-2 text-xs font-medium transition-colors disabled:opacity-40 ${
                  tapModeActive
                    ? 'border-amber-400 bg-amber-500/20 text-amber-300'
                    : 'border-[#334155] bg-[#1B2332] text-slate-200 hover:border-amber-500/60'
                }`}
              >
                <Clock className="h-3.5 w-3.5" />
                {tapModeActive ? 'Tap-Sync aktiv (Leertaste)' : 'Tap-Sync aktivieren'}
              </button>

              <button
                type="button"
                onClick={handleAddPhrase}
                className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-[#334155] bg-[#1B2332] px-3 py-2 text-xs font-medium text-slate-200 hover:border-amber-500/60"
              >
                <Plus className="h-3.5 w-3.5" />
                Zeile
              </button>
            </div>
          </div>

          {/* Transport Bar */}
          <div className="mt-4 flex items-center gap-3 rounded-lg border border-[#263145] bg-[#0B0F17] px-3.5 py-2.5">
            <span className="font-mono-tabular text-xs font-semibold text-amber-400">
              {formatTimecode(currentTimeSec)}
            </span>
            <input
              type="range"
              min={0}
              max={Math.max(1, durationSec || 24)}
              step={0.05}
              value={currentTimeSec}
              disabled={!hasAudio}
              aria-label="Song-Position für Lyrics"
              onChange={(e) => onSeek(Number(e.target.value))}
              className="flex-1 accent-amber-500"
            />
            <span className="font-mono-tabular text-xs text-slate-400">
              {formatTimecode(durationSec || 0)}
            </span>
            {lyrics.length > 0 && (
              <button
                type="button"
                disabled={!hasAudio}
                onClick={handleTapSyncCurrent}
                className="shrink-0 whitespace-nowrap rounded-md bg-[#1B2332] px-2.5 py-1 text-xs font-medium text-amber-300 hover:bg-[#263145] disabled:opacity-40"
              >
                Zeile {activeTapIdx + 1} jetzt setzen
              </button>
            )}
          </div>

          {/* Phrase List */}
          <div className="mt-4 max-h-[430px] flex-1 space-y-2 overflow-y-auto pr-1">
            {lyrics.length === 0 ? (
              <div className="flex flex-col items-center justify-center rounded-lg border border-[#263145] bg-[#0B0F17]/40 px-4 py-12 text-center">
                <FileText className="h-8 w-8 text-slate-500" />
                <p className="mt-2 text-sm font-medium text-slate-300">
                  Noch keine Lyrics geladen
                </p>
                <p className="mt-1 max-w-md text-xs text-slate-400">
                  Suche links nach dem Song auf LRCLIB, lade eine `.lrc`-Datei hoch oder klicke auf „+ Zeile“, um eigene Zeilen hinzuzufügen.
                </p>
              </div>
            ) : (
              lyrics.map((phrase, idx) => {
                const startSec = formatPhraseTimestamp(phrase, bpmMarkers, DEFAULT_RESOLUTION, offsetMs);
                const isSelected = idx === activeTapIdx;
                const currentTick = timeSecToTick(currentTimeSec, bpmMarkers, DEFAULT_RESOLUTION, offsetMs);
                const isActiveNow = currentTick >= phrase.startTick && currentTick <= phrase.endTick;

                return (
                  <div
                    key={phrase.id}
                    onClick={() => setActiveTapIdx(idx)}
                    className={`flex flex-wrap items-center gap-2.5 rounded-lg border px-3 py-2 transition-colors ${
                      isActiveNow
                        ? 'border-amber-400 bg-amber-500/10'
                        : isSelected
                          ? 'border-slate-500 bg-[#1B2332]/70'
                          : 'border-[#263145] bg-[#0B0F17]/70'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onSeek(startSec);
                      }}
                      title="Zu dieser Zeile springen"
                      className="font-mono-tabular shrink-0 rounded bg-[#1B2332] px-2 py-1 text-xs font-medium text-amber-400 hover:bg-[#263145]"
                    >
                      {formatTimecode(startSec)}
                    </button>

                    <input
                      type="text"
                      value={formatPhraseText(phrase)}
                      aria-label={`Lyric Zeile ${idx + 1}`}
                      onChange={(e) => handlePhraseTextChange(idx, e.target.value)}
                      className="min-w-[180px] flex-1 rounded border border-transparent bg-transparent px-2 py-1 text-sm text-slate-100 focus:border-[#334155] focus:bg-[#131924] focus:outline-none"
                    />

                    <span className="font-mono-tabular text-xs text-slate-500">
                      {phrase.syllables.length} Silben
                    </span>

                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleNudgePhrase(idx, -100);
                        }}
                        className="rounded border border-[#334155] bg-[#1B2332] px-2 py-1 text-[11px] font-medium text-slate-300 hover:text-white"
                        title="100ms früher"
                      >
                        -0.1s
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleNudgePhrase(idx, 100);
                        }}
                        className="rounded border border-[#334155] bg-[#1B2332] px-2 py-1 text-[11px] font-medium text-slate-300 hover:text-white"
                        title="100ms später"
                      >
                        +0.1s
                      </button>
                      <button
                        type="button"
                        aria-label={`Zeile ${idx + 1} löschen`}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeletePhrase(idx);
                        }}
                        className="rounded p-1.5 text-slate-400 hover:bg-red-500/15 hover:text-red-300"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </section>
      </div>
    </div>
  );
};
