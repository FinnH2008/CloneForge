/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import JSZip from 'jszip';
import {Download, Loader2} from 'lucide-react';
import {useCallback, useEffect, useRef, useState} from 'react';
import {AdvancedSettingsView} from './components/AdvancedSettingsView';
import {AnalysisAndTagsView} from './components/AnalysisAndTagsView';
import {HighwayEditorView} from './components/HighwayEditorView';
import {LyricsSyncView} from './components/LyricsSyncView';
import type {
  AudioAnalysisResult,
  BpmMarker,
  ChartTracks,
  Difficulty,
  DifficultyConfig,
  DifficultyConfigMap,
  InstrumentMode,
  InstrumentTrack,
  LrcLibResult,
  LyricPhrase,
  MusicBrainzResult,
  SongMetadata,
} from './types/chart';
import {pickBestLyricsResult} from './utils/autoSelect';
import {
  analyzeAudioSamples,
  audioBufferToMono,
  generateDemoAudioSamples,
} from './utils/audioDsp';
import {
  estimateDifficultyTier,
  generateAllCharts,
  generateFiveFretTrack,
  generateGhlTrack,
} from './utils/chartGenerator';
import {
  encodeAudioBufferToWav,
  serializeChartFile,
  serializeSongIni,
} from './utils/chartSerializer';
import {createDefaultDifficultyConfigs} from './utils/difficultyPresets';
import {lrcLinesToPhrases, parseLrcString} from './utils/lyricsSync';
import {DEFAULT_RESOLUTION, parseFilenameMetadata} from './utils/timing';

type ActiveTab = 'analyse' | 'editor' | 'lyrics' | 'advanced';

const EMPTY_TRACKS: ChartTracks = {
  fiveFret: {
    Easy: {notes: [], starPower: []},
    Medium: {notes: [], starPower: []},
    Hard: {notes: [], starPower: []},
    Expert: {notes: [], starPower: []},
  },
  ghl: {
    Easy: {notes: [], starPower: []},
    Medium: {notes: [], starPower: []},
    Hard: {notes: [], starPower: []},
    Expert: {notes: [], starPower: []},
  },
};

const DEMO_LRC = `[00:01.80] Will-kom-men in der Arena
[00:05.60] Sechs Bün-de Schwarz und Weiß
[00:09.40] Spiel den Riff im Takt vor-aus
[00:13.20] Jede No-te sitzt ge-nau
[00:17.00] Star Po-wer zün-det jetzt`;

function triggerBlobDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export default function App() {
  const [activeTab, setActiveTab] = useState<ActiveTab>('analyse');
  const [activeMode, setActiveMode] = useState<InstrumentMode>('ghl');
  const [activeDifficulty, setActiveDifficulty] = useState<Difficulty>('Expert');

  const [isDecoding, setIsDecoding] = useState(false);
  const [decodeError, setDecodeError] = useState<string | null>(null);
  const [sourceFile, setSourceFile] = useState<File | null>(null);
  const [sourceFileName, setSourceFileName] = useState<string | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);

  const [audioBuffer, setAudioBuffer] = useState<AudioBuffer | null>(null);
  const [analysis, setAnalysis] = useState<AudioAnalysisResult | null>(null);
  const [bpmMarkers, setBpmMarkers] = useState<BpmMarker[]>([{tick: 0, bpm: 120}]);
  const [offsetMs, setOffsetMs] = useState(0);

  const [configs, setConfigs] = useState<DifficultyConfigMap>(() => createDefaultDifficultyConfigs());
  const [tracks, setTracks] = useState<ChartTracks>(EMPTY_TRACKS);
  const [history, setHistory] = useState<ChartTracks[]>([]);
  const [future, setFuture] = useState<ChartTracks[]>([]);

  const [lyrics, setLyrics] = useState<LyricPhrase[]>([]);
  const [mbResults, setMbResults] = useState<MusicBrainzResult[]>([]);
  const [lrcResults, setLrcResults] = useState<LrcLibResult[]>([]);
  const [autoPipeline, setAutoPipeline] = useState<{
    running: boolean;
    mbSummary: string | null;
    lyricsSummary: string | null;
  }>({running: false, mbSummary: null, lyricsSummary: null});
  const [metadata, setMetadata] = useState<SongMetadata>({
    title: '',
    artist: '',
    album: '',
    year: '2026',
    genre: 'Rock',
    charter: 'CloneForge Studio',
    diffGuitar: 3,
    diffGuitarGhl: 4,
    previewStartMs: 5000,
    includeVideo: true,
    coverDataUrl: null,
    coverMime: null,
    mbid: null,
    releaseMbid: null,
  });

  // Playback engine state
  const audioCtxRef = useRef<AudioContext | null>(null);
  const sourceNodeRef = useRef<AudioBufferSourceNode | null>(null);
  const playStartCtxTimeRef = useRef<number>(0);
  const playOffsetSecRef = useRef<number>(0);
  const rafRef = useRef<number | null>(null);

  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTimeSec, setCurrentTimeSec] = useState(0);

  const [isExporting, setIsExporting] = useState(false);
  const [statusNotice, setStatusNotice] = useState<string | null>(null);

  const showNotice = useCallback((msg: string) => {
    setStatusNotice(msg);
    setTimeout(() => {
      setStatusNotice((prev) => (prev === msg ? null : prev));
    }, 3500);
  }, []);

  const stopPlaybackNodes = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (sourceNodeRef.current) {
      try {
        sourceNodeRef.current.stop();
        sourceNodeRef.current.disconnect();
      } catch {
        // already stopped
      }
      sourceNodeRef.current = null;
    }
  }, []);

  const getAudioContext = useCallback((): AudioContext => {
    if (!audioCtxRef.current) {
      const Ctx = window.AudioContext || (window as unknown as {webkitAudioContext: typeof AudioContext}).webkitAudioContext;
      audioCtxRef.current = new Ctx();
    }
    if (audioCtxRef.current.state === 'suspended') {
      audioCtxRef.current.resume().catch(() => {});
    }
    return audioCtxRef.current;
  }, []);

  const startPlaybackAt = useCallback(
    (startSec: number) => {
      if (!audioBuffer) return;
      stopPlaybackNodes();
      const ctx = getAudioContext();
      const safeStart = Math.max(0, Math.min(audioBuffer.duration - 0.02, startSec));
      const node = ctx.createBufferSource();
      node.buffer = audioBuffer;
      node.connect(ctx.destination);
      node.start(0, safeStart);
      sourceNodeRef.current = node;
      playStartCtxTimeRef.current = ctx.currentTime;
      playOffsetSecRef.current = safeStart;
      setIsPlaying(true);

      const tickLoop = () => {
        const elapsed = ctx.currentTime - playStartCtxTimeRef.current;
        const pos = playOffsetSecRef.current + elapsed;
        if (pos >= audioBuffer.duration) {
          stopPlaybackNodes();
          setIsPlaying(false);
          setCurrentTimeSec(0);
          playOffsetSecRef.current = 0;
          return;
        }
        setCurrentTimeSec(pos);
        rafRef.current = requestAnimationFrame(tickLoop);
      };
      rafRef.current = requestAnimationFrame(tickLoop);
    },
    [audioBuffer, getAudioContext, stopPlaybackNodes]
  );

  const handleTogglePlay = useCallback(() => {
    if (!audioBuffer) return;
    if (isPlaying) {
      const ctx = audioCtxRef.current;
      const pos = ctx
        ? Math.min(audioBuffer.duration, playOffsetSecRef.current + (ctx.currentTime - playStartCtxTimeRef.current))
        : currentTimeSec;
      stopPlaybackNodes();
      playOffsetSecRef.current = pos;
      setCurrentTimeSec(pos);
      setIsPlaying(false);
    } else {
      startPlaybackAt(currentTimeSec);
    }
  }, [audioBuffer, currentTimeSec, isPlaying, startPlaybackAt, stopPlaybackNodes]);

  const handleStop = useCallback(() => {
    stopPlaybackNodes();
    playOffsetSecRef.current = 0;
    setCurrentTimeSec(0);
    setIsPlaying(false);
  }, [stopPlaybackNodes]);

  const handleSeek = useCallback(
    (sec: number) => {
      const clamped = Math.max(0, Math.min(audioBuffer?.duration ?? 24, sec));
      playOffsetSecRef.current = clamped;
      setCurrentTimeSec(clamped);
      if (isPlaying) {
        startPlaybackAt(clamped);
      }
    },
    [audioBuffer, isPlaying, startPlaybackAt]
  );

  useEffect(() => {
    return () => {
      stopPlaybackNodes();
      if (videoUrl) URL.revokeObjectURL(videoUrl);
    };
  }, [stopPlaybackNodes, videoUrl]);

  const runInitialChartGeneration = useCallback(
    (
      buffer: AudioBuffer,
      meta: Partial<SongMetadata>,
      fileName: string,
      rawFile: File | null,
      vidUrl: string | null,
      seedLrc?: string,
      preAnalysis?: AudioAnalysisResult
    ) => {
      const dsp =
        preAnalysis ?? analyzeAudioSamples(audioBufferToMono(buffer), buffer.sampleRate, buffer.duration);
      const initialBpm: BpmMarker[] =
        dsp.bpmMarkers && dsp.bpmMarkers.length > 0 ? dsp.bpmMarkers : [{tick: 0, bpm: dsp.bpm}];
      const generated = generateAllCharts(
        dsp.onsets,
        configs,
        initialBpm,
        dsp.offsetMs,
        dsp.durationSec,
        DEFAULT_RESOLUTION
      );

      setAudioBuffer(buffer);
      setAnalysis(dsp);
      setBpmMarkers(initialBpm);
      setOffsetMs(dsp.offsetMs);
      setTracks(generated);
      setHistory([]);
      setFuture([]);
      setSourceFile(rawFile);
      setSourceFileName(fileName);
      setVideoUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return vidUrl;
      });
      setCurrentTimeSec(0);
      playOffsetSecRef.current = 0;
      setIsPlaying(false);

      const diff5 = estimateDifficultyTier(generated.fiveFret.Expert.notes, dsp.durationSec);
      const diffGhl = estimateDifficultyTier(generated.ghl.Expert.notes, dsp.durationSec);

      setMetadata((prev) => ({
        ...prev,
        title: meta.title ?? prev.title,
        artist: meta.artist ?? prev.artist,
        album: meta.album ?? prev.album,
        year: meta.year ?? prev.year,
        genre: meta.genre ?? prev.genre,
        coverDataUrl: meta.coverDataUrl !== undefined ? meta.coverDataUrl : prev.coverDataUrl,
        coverMime: meta.coverMime !== undefined ? meta.coverMime : prev.coverMime,
        mbid: meta.mbid !== undefined ? meta.mbid : prev.mbid,
        releaseMbid: meta.releaseMbid !== undefined ? meta.releaseMbid : prev.releaseMbid,
        diffGuitar: diff5,
        diffGuitarGhl: diffGhl,
        previewStartMs: Math.min(Math.round(dsp.durationSec * 400), 15000),
      }));

      if (seedLrc) {
        const parsed = parseLrcString(seedLrc);
        setLyrics(
          lrcLinesToPhrases(parsed, initialBpm, DEFAULT_RESOLUTION, dsp.offsetMs, dsp.durationSec)
        );
      }
    },
    [configs]
  );

  const runAutoEnrichPipeline = useCallback(
    async (
      artistInput: string,
      titleInput: string,
      durationSec: number,
      activeBpm: BpmMarker[],
      activeOffsetMs: number
    ) => {
      if (!titleInput && !artistInput) return;

      setAutoPipeline({
        running: true,
        mbSummary: 'MusicBrainz & Cover werden automatisch ermittelt...',
        lyricsSummary: 'Songtexte (LRCLIB) werden automatisch gesucht...',
      });

      let resolvedTitle = titleInput;
      let resolvedArtist = artistInput;
      let mbSummary = 'MusicBrainz: Kein eindeutiger Studio-Treffer';

      try {
        const mbParams = new URLSearchParams();
        if (titleInput) mbParams.set('title', titleInput);
        if (artistInput) mbParams.set('artist', artistInput);
        if (!titleInput && artistInput) mbParams.set('q', artistInput);
        if (durationSec > 0) mbParams.set('durationSec', String(Math.round(durationSec)));
        mbParams.set('enrich', '1');

        const mbRes = await fetch(`/api/musicbrainz/search?${mbParams.toString()}`);
        if (mbRes.ok) {
          const mbData = await mbRes.json();
          const list: MusicBrainzResult[] = Array.isArray(mbData.results) ? mbData.results : [];
          setMbResults(list);

          const best = list[0];
          if (best) {
            resolvedTitle = best.title || resolvedTitle;
            resolvedArtist = best.artist || resolvedArtist;
            const chosenRel = best.releases[0];
            const yearMatch = (chosenRel?.date || best.year || '').match(/\d{4}/);

            setMetadata((prev) => ({
              ...prev,
              title: best.title || prev.title,
              artist: best.artist || prev.artist,
              album: chosenRel?.title || best.album || prev.album,
              year: yearMatch ? yearMatch[0] : prev.year,
              genre: best.genre || prev.genre,
              mbid: best.mbid,
              releaseMbid: chosenRel?.id || best.releaseMbid || null,
            }));

            let coverFound = false;
            const candidateIds = Array.from(
              new Set(
                [
                  chosenRel?.id,
                  best.releaseMbid,
                  ...best.releases.slice(0, 4).map((r) => r.id),
                ].filter((id): id is string => Boolean(id))
              )
            );
            for (const relId of candidateIds) {
              try {
                const covRes = await fetch(`/api/musicbrainz/cover/${relId}`);
                if (covRes.ok) {
                  const covData = await covRes.json();
                  if (covData.dataUrl) {
                    setMetadata((prev) => ({
                      ...prev,
                      coverDataUrl: covData.dataUrl,
                      coverMime: covData.mimeType || 'image/jpeg',
                    }));
                    coverFound = true;
                    break;
                  }
                }
              } catch {
                // continue trying next candidate release
              }
            }

            mbSummary = `MusicBrainz: ${best.artist} – ${best.title}${chosenRel?.title ? ` (${chosenRel.title})` : ''}${coverFound ? ' + Cover' : ''}`;
          }
        }
      } catch {
        mbSummary = 'MusicBrainz derzeit nicht erreichbar (Tags manuell bearbeitbar)';
      }

      let lyricsSummary = 'Lyrics: Keine passenden Treffer bei LRCLIB';
      try {
        const lrcParams = new URLSearchParams();
        if (resolvedTitle) {
          lrcParams.set('track_name', resolvedTitle);
          if (resolvedArtist) lrcParams.set('artist_name', resolvedArtist);
        } else {
          lrcParams.set('q', [resolvedArtist, resolvedTitle].filter(Boolean).join(' '));
        }

        let lrcRes = await fetch(`/api/lyrics/search?${lrcParams.toString()}`);
        let list: LrcLibResult[] = [];
        if (lrcRes.ok) {
          const lrcData = await lrcRes.json();
          list = Array.isArray(lrcData.results) ? lrcData.results : [];
        }

        // Fallback broader search if strict track_name/artist_name missed
        if (list.length === 0 && resolvedTitle) {
          const fallbackParams = new URLSearchParams({
            q: [resolvedArtist, resolvedTitle].filter(Boolean).join(' '),
          });
          lrcRes = await fetch(`/api/lyrics/search?${fallbackParams.toString()}`);
          if (lrcRes.ok) {
            const fbData = await lrcRes.json();
            list = Array.isArray(fbData.results) ? fbData.results : [];
          }
        }

        setLrcResults(list);
        const bestLrc = pickBestLyricsResult(list, durationSec, resolvedTitle);
        if (bestLrc) {
          if (bestLrc.syncedLyrics) {
            const parsed = parseLrcString(bestLrc.syncedLyrics);
            const phrases = lrcLinesToPhrases(
              parsed,
              activeBpm,
              DEFAULT_RESOLUTION,
              activeOffsetMs,
              durationSec || 180
            );
            setLyrics(phrases);
            lyricsSummary = `Lyrics: ${phrases.length} synchronisierte Zeilen automatisch geladen`;
          } else if (bestLrc.plainLyrics) {
            const {plainTextToTimedPhrases} = await import('./utils/lyricsSync');
            const phrases = plainTextToTimedPhrases(
              bestLrc.plainLyrics,
              durationSec || 180,
              activeBpm,
              DEFAULT_RESOLUTION,
              activeOffsetMs
            );
            setLyrics(phrases);
            lyricsSummary = `Lyrics: ${phrases.length} Textzeilen automatisch auf Song verteilt`;
          }
        }
      } catch {
        lyricsSummary = 'Lyrics-Abruf fehlgeschlagen (manuell im Tab Lyrics & Sync ladbar)';
      }

      setAutoPipeline({
        running: false,
        mbSummary,
        lyricsSummary,
      });
      showNotice('Charts, MusicBrainz-Tags & Songtexte automatisch erstellt');
    },
    [showNotice]
  );

  const handleFileSelected = useCallback(
    async (file: File) => {
      setIsDecoding(true);
      setDecodeError(null);
      stopPlaybackNodes();

      try {
        const arrayBuf = await file.arrayBuffer();
        const ctx = getAudioContext();
        const decoded = await ctx.decodeAudioData(arrayBuf.slice(0));
        const parsedMeta = parseFilenameMetadata(file.name);
        const isMp4 = file.type.includes('mp4') || file.name.toLowerCase().endsWith('.mp4');
        const vidUrl = isMp4 ? URL.createObjectURL(file) : null;

        const mono = audioBufferToMono(decoded);
        const dsp = analyzeAudioSamples(mono, decoded.sampleRate, decoded.duration);
        const initialBpm: BpmMarker[] =
          dsp.bpmMarkers && dsp.bpmMarkers.length > 0 ? dsp.bpmMarkers : [{tick: 0, bpm: dsp.bpm}];

        runInitialChartGeneration(
          decoded,
          {
            title: parsedMeta.title,
            artist: parsedMeta.artist || 'Unbekannter Interpret',
            album: 'Single',
            year: '2026',
            genre: 'Rock',
            coverDataUrl: null,
            coverMime: null,
            mbid: null,
            releaseMbid: null,
          },
          file.name,
          file,
          vidUrl,
          undefined,
          dsp
        );
        setLyrics([]);
        setMbResults([]);
        setLrcResults([]);
        setIsDecoding(false);

        // Run automatic MusicBrainz tagging, Cover Art, and LRCLIB synced lyrics immediately
        void runAutoEnrichPipeline(
          parsedMeta.artist,
          parsedMeta.title,
          decoded.duration,
          initialBpm,
          dsp.offsetMs
        );
      } catch (err) {
        console.error('Audio decode error:', err);
        setDecodeError(
          'Datei konnte nicht dekodiert werden. Bitte eine gültige MP3-, MP4-, WAV- oder OGG-Datei wählen.'
        );
        setIsDecoding(false);
      }
    },
    [getAudioContext, runAutoEnrichPipeline, runInitialChartGeneration, stopPlaybackNodes]
  );

  const handleLoadDemoSong = useCallback(() => {
    setIsDecoding(true);
    setDecodeError(null);
    stopPlaybackNodes();

    try {
      const sampleRate = 22050;
      const durationSec = 24;
      const samples = generateDemoAudioSamples(sampleRate, durationSec);
      const offline = new OfflineAudioContext(1, samples.length, sampleRate);
      const buffer = offline.createBuffer(1, samples.length, sampleRate);
      buffer.getChannelData(0).set(samples);

      setAutoPipeline({running: false, mbSummary: null, lyricsSummary: null});
      setMbResults([]);
      setLrcResults([]);

      runInitialChartGeneration(
        buffer,
        {
          title: 'Neon Highway Riff (Demo)',
          artist: 'CloneForge Session',
          album: 'Studio Test Track',
          year: '2026',
          genre: 'Synth Rock',
          coverDataUrl: null,
          coverMime: null,
          mbid: null,
          releaseMbid: null,
        },
        'CloneForge Session - Neon Highway Riff.wav',
        null,
        null,
        DEMO_LRC
      );
      showNotice('Demo-Song (128 BPM) für 5-Fret & 6-Bund GHL generiert');
    } catch {
      setDecodeError('Demo-Audiopuffer konnte nicht erstellt werden.');
    } finally {
      setIsDecoding(false);
    }
  }, [runInitialChartGeneration, showNotice, stopPlaybackNodes]);

  // ?autostart=1 support for direct workspace testing
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('autostart') === '1' && !audioBuffer) {
      handleLoadDemoSong();
      setActiveTab('editor');
    }
  }, [audioBuffer, handleLoadDemoSong]);

  const pushTracksWithUndo = useCallback(
    (nextTracks: ChartTracks) => {
      setHistory((prev) => [...prev.slice(-24), tracks]);
      setFuture([]);
      setTracks(nextTracks);
    },
    [tracks]
  );

  const handleRegenerateAll = useCallback(() => {
    if (!analysis) return;
    const regenerated = generateAllCharts(
      analysis.onsets,
      configs,
      bpmMarkers,
      offsetMs,
      analysis.durationSec,
      DEFAULT_RESOLUTION
    );
    pushTracksWithUndo(regenerated);
    showNotice('Alle 8 Spuren (5-Fret & 6-Bund GHL) neu generiert');
  }, [analysis, bpmMarkers, configs, offsetMs, pushTracksWithUndo, showNotice]);

  const handleRegenerateSingle = useCallback(
    (mode: InstrumentMode, diff: Difficulty) => {
      if (!analysis) return;
      const modeKey = mode === '5fret' ? 'fiveFret' : 'ghl';
      const newTrack =
        mode === '5fret'
          ? generateFiveFretTrack(
              analysis.onsets,
              configs.fiveFret[diff],
              bpmMarkers,
              offsetMs,
              analysis.durationSec,
              DEFAULT_RESOLUTION
            )
          : generateGhlTrack(
              analysis.onsets,
              configs.ghl[diff],
              bpmMarkers,
              offsetMs,
              analysis.durationSec,
              DEFAULT_RESOLUTION
            );

      const nextTracks: ChartTracks = {
        fiveFret: {...tracks.fiveFret},
        ghl: {...tracks.ghl},
      };
      nextTracks[modeKey][diff] = newTrack;
      pushTracksWithUndo(nextTracks);
      showNotice(`${mode === 'ghl' ? '6-Bund GHL' : '5-Fret'} · ${diff} neu generiert`);
    },
    [analysis, bpmMarkers, configs, offsetMs, pushTracksWithUndo, showNotice, tracks]
  );

  const handleUpdateBpm = useCallback(
    (newBpm: number) => {
      const nextMarkers: BpmMarker[] = [{tick: 0, bpm: newBpm}, ...bpmMarkers.slice(1)];
      setBpmMarkers(nextMarkers);
      if (analysis) {
        const regenerated = generateAllCharts(
          analysis.onsets,
          configs,
          nextMarkers,
          offsetMs,
          analysis.durationSec,
          DEFAULT_RESOLUTION
        );
        pushTracksWithUndo(regenerated);
      }
    },
    [analysis, bpmMarkers, configs, offsetMs, pushTracksWithUndo]
  );

  const handleUpdateOffsetMs = useCallback(
    (nextOffset: number) => {
      setOffsetMs(nextOffset);
      if (analysis) {
        const regenerated = generateAllCharts(
          analysis.onsets,
          configs,
          bpmMarkers,
          nextOffset,
          analysis.durationSec,
          DEFAULT_RESOLUTION
        );
        pushTracksWithUndo(regenerated);
      }
    },
    [analysis, bpmMarkers, configs, pushTracksWithUndo]
  );

  const handleUpdateConfig = useCallback(
    (mode: InstrumentMode, diff: Difficulty, patch: Partial<DifficultyConfig>) => {
      const modeKey = mode === '5fret' ? 'fiveFret' : 'ghl';
      setConfigs((prev) => ({
        ...prev,
        [modeKey]: {
          ...prev[modeKey],
          [diff]: {
            ...prev[modeKey][diff],
            ...patch,
          },
        },
      }));
    },
    []
  );

  const handleUpdateTrack = useCallback(
    (mode: InstrumentMode, diff: Difficulty, nextTrack: InstrumentTrack) => {
      const modeKey = mode === '5fret' ? 'fiveFret' : 'ghl';
      const nextTracks: ChartTracks = {
        fiveFret: {...tracks.fiveFret},
        ghl: {...tracks.ghl},
      };
      nextTracks[modeKey][diff] = nextTrack;
      pushTracksWithUndo(nextTracks);
    },
    [pushTracksWithUndo, tracks]
  );

  const handleUndo = useCallback(() => {
    if (history.length === 0) return;
    const prev = history[history.length - 1];
    setHistory((h) => h.slice(0, -1));
    setFuture((f) => [tracks, ...f]);
    setTracks(prev);
  }, [history, tracks]);

  const handleRedo = useCallback(() => {
    if (future.length === 0) return;
    const next = future[0];
    setFuture((f) => f.slice(1));
    setHistory((h) => [...h, tracks]);
    setTracks(next);
  }, [future, tracks]);

  const handleExportZip = async () => {
    if (!audioBuffer) return;
    setIsExporting(true);
    try {
      const zip = new JSZip();
      const safeArtist = (metadata.artist || 'Artist').replace(/[\\/:*?"<>|]/g, '_');
      const safeTitle = (metadata.title || 'Song').replace(/[\\/:*?"<>|]/g, '_');
      const folderName = `${safeArtist} - ${safeTitle}`;
      const folder = zip.folder(folderName) || zip;

      const isOriginalMp3 = sourceFile && sourceFile.name.toLowerCase().endsWith('.mp3');
      const audioFilename = isOriginalMp3 ? 'song.mp3' : 'song.wav';

      const chartText = serializeChartFile({
        metadata,
        bpmMarkers,
        lyrics,
        tracks,
        offsetMs,
        resolution: DEFAULT_RESOLUTION,
        audioFilename,
      });

      const iniText = serializeSongIni(
        metadata,
        audioBuffer.duration,
        Boolean(videoUrl && sourceFile)
      );

      folder.file('notes.chart', chartText);
      folder.file('song.ini', iniText);

      if (isOriginalMp3 && sourceFile) {
        folder.file('song.mp3', await sourceFile.arrayBuffer());
      } else {
        folder.file('song.wav', encodeAudioBufferToWav(audioBuffer));
      }

      if (videoUrl && sourceFile && metadata.includeVideo) {
        folder.file('video.mp4', await sourceFile.arrayBuffer());
      }

      if (metadata.coverDataUrl && metadata.coverDataUrl.includes(',')) {
        const ext = metadata.coverMime?.includes('png') ? 'png' : 'jpg';
        const base64 = metadata.coverDataUrl.split(',')[1];
        folder.file(`album.${ext}`, base64, {base64: true});
      }

      const zipBlob = await zip.generateAsync({type: 'blob'});
      triggerBlobDownload(zipBlob, `${folderName}.zip`);
      showNotice(`Clone Hero Paket exportiert: ${folderName}.zip`);
    } catch (err) {
      console.error('Export failed:', err);
      showNotice('Fehler beim Erstellen des ZIP-Pakets');
    } finally {
      setIsExporting(false);
    }
  };

  const handleDownloadChartOnly = () => {
    const chartText = serializeChartFile({
      metadata,
      bpmMarkers,
      lyrics,
      tracks,
      offsetMs,
      resolution: DEFAULT_RESOLUTION,
    });
    triggerBlobDownload(new Blob([chartText], {type: 'text/plain;charset=utf-8'}), 'notes.chart');
  };

  const handleDownloadIniOnly = () => {
    const iniText = serializeSongIni(
      metadata,
      audioBuffer?.duration ?? 24,
      Boolean(videoUrl && sourceFile)
    );
    triggerBlobDownload(new Blob([iniText], {type: 'text/plain;charset=utf-8'}), 'song.ini');
  };

  return (
    <div className="min-h-screen bg-[#0B0F17] text-slate-100">
      {/* Strict 3-Zone Top Bar Contract */}
      <header className="sticky top-0 z-30 border-b border-[#263145] bg-[#0B0F17]/95 backdrop-blur-sm">
        <div className="mx-auto flex max-w-[1440px] items-center justify-between gap-8 px-6 py-3.5">
          {/* Zone 1: Single-element Brand wordmark */}
          <a
            href="#top"
            onClick={(e) => {
              e.preventDefault();
              setActiveTab('analyse');
            }}
            className="font-display shrink-0 whitespace-nowrap text-lg font-bold tracking-tight text-slate-100"
          >
            CloneForge Studio
          </a>

          {/* Zone 2: Clean single-line navigation tabs */}
          <nav aria-label="Studio Navigation" className="flex items-center gap-6 overflow-x-auto">
            {(
              [
                ['analyse', 'Analyse & Tags'],
                ['editor', 'Noten-Editor'],
                ['lyrics', 'Lyrics & Sync'],
                ['advanced', 'Fortgeschritten'],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setActiveTab(id)}
                className={`shrink-0 whitespace-nowrap border-b-2 py-1 text-sm font-medium transition-colors ${
                  activeTab === id
                    ? 'border-amber-500 text-slate-100'
                    : 'border-transparent text-slate-400 hover:text-slate-200'
                }`}
              >
                {label}
              </button>
            ))}
          </nav>

          {/* Zone 3: 1 Primary CTA */}
          <div className="shrink-0">
            <button
              type="button"
              disabled={!audioBuffer || isExporting}
              onClick={handleExportZip}
              className="inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-lg bg-amber-500 px-4 py-2 text-xs font-semibold text-slate-950 transition-colors hover:bg-amber-400 focus-visible:outline-2 focus-visible:outline-amber-400 disabled:opacity-40"
            >
              {isExporting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Download className="h-4 w-4" />
              )}
              ZIP Exportieren
            </button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main id="top">
        {activeTab === 'analyse' && (
          <AnalysisAndTagsView
            hasAudio={Boolean(audioBuffer)}
            isDecoding={isDecoding}
            decodeError={decodeError}
            sourceFileName={sourceFileName}
            hasVideo={Boolean(videoUrl)}
            analysis={analysis}
            bpmMarkers={bpmMarkers}
            offsetMs={offsetMs}
            metadata={metadata}
            tracks={tracks}
            mbResults={mbResults}
            autoPipeline={autoPipeline}
            onSetMbResults={setMbResults}
            onRunAutoPipeline={() =>
              runAutoEnrichPipeline(
                metadata.artist,
                metadata.title,
                audioBuffer?.duration ?? 0,
                bpmMarkers,
                offsetMs
              )
            }
            onFileSelected={handleFileSelected}
            onLoadDemoSong={handleLoadDemoSong}
            onUpdateBpm={handleUpdateBpm}
            onUpdateOffsetMs={handleUpdateOffsetMs}
            onUpdateMetadata={(patch) => setMetadata((prev) => ({...prev, ...patch}))}
            onOpenInEditor={(mode, diff) => {
              setActiveMode(mode);
              setActiveDifficulty(diff);
              setActiveTab('editor');
            }}
            onRegenerateAll={handleRegenerateAll}
          />
        )}

        {activeTab === 'editor' && (
          <HighwayEditorView
            hasAudio={Boolean(audioBuffer)}
            isPlaying={isPlaying}
            currentTimeSec={currentTimeSec}
            durationSec={audioBuffer?.duration ?? 0}
            videoUrl={videoUrl}
            analysis={analysis}
            bpmMarkers={bpmMarkers}
            offsetMs={offsetMs}
            metadata={metadata}
            lyrics={lyrics}
            tracks={tracks}
            activeMode={activeMode}
            activeDifficulty={activeDifficulty}
            canUndo={history.length > 0}
            canRedo={future.length > 0}
            onSelectMode={setActiveMode}
            onSelectDifficulty={setActiveDifficulty}
            onTogglePlay={handleTogglePlay}
            onStop={handleStop}
            onSeek={handleSeek}
            onUpdateTrack={handleUpdateTrack}
            onUndo={handleUndo}
            onRedo={handleRedo}
            onDownloadChartOnly={handleDownloadChartOnly}
            onDownloadIniOnly={handleDownloadIniOnly}
          />
        )}

        {activeTab === 'lyrics' && (
          <LyricsSyncView
            hasAudio={Boolean(audioBuffer)}
            isPlaying={isPlaying}
            currentTimeSec={currentTimeSec}
            durationSec={audioBuffer?.duration ?? 0}
            bpmMarkers={bpmMarkers}
            offsetMs={offsetMs}
            metadata={metadata}
            lyrics={lyrics}
            lrcResults={lrcResults}
            onSetLrcResults={setLrcResults}
            onTogglePlay={handleTogglePlay}
            onSeek={handleSeek}
            onSetLyrics={setLyrics}
          />
        )}

        {activeTab === 'advanced' && (
          <AdvancedSettingsView
            hasAudio={Boolean(audioBuffer)}
            activeMode={activeMode}
            activeDifficulty={activeDifficulty}
            configs={configs}
            onSelectMode={setActiveMode}
            onSelectDifficulty={setActiveDifficulty}
            onUpdateConfig={handleUpdateConfig}
            onRegenerateSingle={handleRegenerateSingle}
            onRegenerateAll={handleRegenerateAll}
            onResetDefaults={() => setConfigs(createDefaultDifficultyConfigs())}
          />
        )}
      </main>

      {/* Ephemeral Action Confirmation Toast */}
      {statusNotice && (
        <div
          role="status"
          className="fixed right-6 bottom-6 z-40 rounded-lg border border-[#334155] bg-[#131924] px-4 py-2.5 text-xs font-medium text-slate-100 shadow-lg"
        >
          {statusNotice}
        </div>
      )}
    </div>
  );
}
