import React, {useEffect, useMemo, useRef, useState} from 'react';
import {
  Code2,
  Download,
  Eraser,
  MousePointer,
  Pause,
  Pencil,
  Play,
  Redo2,
  Sparkles,
  Square,
  Trash2,
  Undo2,
  Zap,
} from 'lucide-react';
import type {
  AnyFretId,
  AudioAnalysisResult,
  BpmMarker,
  ChartNote,
  ChartTracks,
  Difficulty,
  EditorTool,
  InstrumentMode,
  InstrumentTrack,
  LyricPhrase,
  QuantizeGrid,
  SongMetadata,
} from '../types/chart';
import {getUniqueNoteCount} from '../utils/chartGenerator';
import {
  getFretDisplayLabel,
  serializeChartFile,
  serializeSongIni,
} from '../utils/chartSerializer';
import {DIFFICULTIES} from '../utils/difficultyPresets';
import {getActiveLyricDisplay} from '../utils/lyricsSync';
import {
  DEFAULT_RESOLUTION,
  formatTimecode,
  getGridStepTicks,
  quantizeTick,
  tickToTimeSec,
  timeSecToTick,
} from '../utils/timing';

interface HighwayEditorViewProps {
  hasAudio: boolean;
  isPlaying: boolean;
  currentTimeSec: number;
  durationSec: number;
  videoUrl: string | null;
  analysis: AudioAnalysisResult | null;
  bpmMarkers: BpmMarker[];
  offsetMs: number;
  metadata: SongMetadata;
  lyrics: LyricPhrase[];
  tracks: ChartTracks;
  activeMode: InstrumentMode;
  activeDifficulty: Difficulty;
  canUndo: boolean;
  canRedo: boolean;
  onSelectMode: (mode: InstrumentMode) => void;
  onSelectDifficulty: (diff: Difficulty) => void;
  onTogglePlay: () => void;
  onStop: () => void;
  onSeek: (sec: number) => void;
  onUpdateTrack: (mode: InstrumentMode, diff: Difficulty, nextTrack: InstrumentTrack) => void;
  onUndo: () => void;
  onRedo: () => void;
  onDownloadChartOnly: () => void;
  onDownloadIniOnly: () => void;
}

const FIVE_FRET_LANES: {id: AnyFretId; label: string; color: string}[] = [
  {id: 'G', label: 'Grün', color: '#22C55E'},
  {id: 'R', label: 'Rot', color: '#EF4444'},
  {id: 'Y', label: 'Gelb', color: '#EAB308'},
  {id: 'B', label: 'Blau', color: '#3B82F6'},
  {id: 'O', label: 'Orange', color: '#F97316'},
];

// 6-Fret GHL grouped into 3 paired columns (White left/bottom, Black right/top)
const GHL_SUBLANES: {id: AnyFretId; label: string; col: number; isBlack: boolean}[] = [
  {id: 'W1', label: 'W1', col: 0, isBlack: false},
  {id: 'B1', label: 'B1', col: 0, isBlack: true},
  {id: 'W2', label: 'W2', col: 1, isBlack: false},
  {id: 'B2', label: 'B2', col: 1, isBlack: true},
  {id: 'W3', label: 'W3', col: 2, isBlack: false},
  {id: 'B3', label: 'B3', col: 2, isBlack: true},
];

export const HighwayEditorView: React.FC<HighwayEditorViewProps> = ({
  hasAudio,
  isPlaying,
  currentTimeSec,
  durationSec,
  videoUrl,
  analysis,
  bpmMarkers,
  offsetMs,
  metadata,
  lyrics,
  tracks,
  activeMode,
  activeDifficulty,
  canUndo,
  canRedo,
  onSelectMode,
  onSelectDifficulty,
  onTogglePlay,
  onStop,
  onSeek,
  onUpdateTrack,
  onUndo,
  onRedo,
  onDownloadChartOnly,
  onDownloadIniOnly,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  const [tool, setTool] = useState<EditorTool>('select');
  const [snapGrid, setSnapGrid] = useState<QuantizeGrid>(16);
  const [pixelsPerSecond, setPixelsPerSecond] = useState(210);
  const [selectedNoteIds, setSelectedNoteIds] = useState<string[]>([]);
  const [showCodePanel, setShowCodePanel] = useState(false);

  // Star Power drag state
  const spDragStartTickRef = useRef<number | null>(null);
  const noteDragRef = useRef<{noteId: string; origTick: number; startY: number} | null>(null);

  const currentTrack =
    activeMode === '5fret' ? tracks.fiveFret[activeDifficulty] : tracks.ghl[activeDifficulty];

  const selectedNotes = useMemo(
    () => currentTrack.notes.filter((n) => selectedNoteIds.includes(n.id)),
    [currentTrack.notes, selectedNoteIds]
  );

  // Sync MP4 preview video element with audio playhead
  useEffect(() => {
    const vid = videoRef.current;
    if (!vid || !videoUrl) return;
    if (Math.abs(vid.currentTime - currentTimeSec) > 0.22) {
      vid.currentTime = currentTimeSec;
    }
    if (isPlaying && vid.paused) {
      vid.play().catch(() => {});
    } else if (!isPlaying && !vid.paused) {
      vid.pause();
    }
  }, [currentTimeSec, isPlaying, videoUrl]);

  // Keyboard shortcuts inside editor
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')) {
        return;
      }

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) onRedo();
        else onUndo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        onRedo();
        return;
      }

      if (e.code === 'Space') {
        e.preventDefault();
        onTogglePlay();
        return;
      }

      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedNoteIds.length > 0) {
        e.preventDefault();
        deleteSelectedNotes();
        return;
      }

      // Quick note placement at playhead via keys 1..6 (or 7 for Open)
      if (!hasAudio) return;
      const keyMap5: Record<string, AnyFretId> = {'1': 'G', '2': 'R', '3': 'Y', '4': 'B', '5': 'O', '7': 'OPEN'};
      const keyMapGhl: Record<string, AnyFretId> = {
        '1': 'W1',
        '2': 'W2',
        '3': 'W3',
        '4': 'B1',
        '5': 'B2',
        '6': 'B3',
        '7': 'OPEN',
      };
      const mapped = activeMode === '5fret' ? keyMap5[e.key] : keyMapGhl[e.key];
      if (mapped) {
        e.preventDefault();
        const rawTick = timeSecToTick(currentTimeSec, bpmMarkers, DEFAULT_RESOLUTION, offsetMs);
        const tick = quantizeTick(rawTick, DEFAULT_RESOLUTION, snapGrid);
        toggleNoteAt(tick, mapped);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  // Draw the interactive 2D Highway Canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (width === 0 || height === 0) return;

    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
    }

    ctx.save();
    ctx.scale(dpr, dpr);

    // Background
    ctx.fillStyle = '#080B12';
    ctx.fillRect(0, 0, width, height);

    const strikeY = height - 74;
    const boardWidth = Math.min(width - 80, activeMode === 'ghl' ? 540 : 520);
    const boardLeft = (width - boardWidth) / 2;

    // Highway deck background
    ctx.fillStyle = '#0F1521';
    ctx.fillRect(boardLeft, 0, boardWidth, height);

    // Outer deck borders
    ctx.strokeStyle = '#263145';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(boardLeft, 0, boardWidth, height);

    const visiblePastSec = strikeY / pixelsPerSecond;
    const visibleFutureSec = (height - strikeY) / pixelsPerSecond;
    // Wait: in Clone Hero notes fall downward toward strikeY!
    // So future notes are ABOVE strikeY (y < strikeY), and past notes are BELOW strikeY (y > strikeY).
    const minVisibleSec = currentTimeSec - visibleFutureSec;
    const maxVisibleSec = currentTimeSec + (strikeY / pixelsPerSecond);
    const timeToY = (tSec: number) => strikeY - (tSec - currentTimeSec) * pixelsPerSecond;

    // Draw subtle background waveform strip on left gutter
    if (analysis && analysis.waveformPeaks.length > 0 && durationSec > 0) {
      const gutterX = Math.max(12, boardLeft - 44);
      ctx.fillStyle = 'rgba(245, 158, 11, 0.25)';
      const stepPx = 4;
      for (let y = 0; y < height; y += stepPx) {
        const t = currentTimeSec + (strikeY - y) / pixelsPerSecond;
        if (t < 0 || t > durationSec) continue;
        const pIdx = Math.min(
          analysis.waveformPeaks.length - 1,
          Math.floor((t / durationSec) * analysis.waveformPeaks.length)
        );
        const wBar = Math.max(2, analysis.waveformPeaks[pIdx] * 30);
        ctx.fillRect(gutterX + (30 - wBar), y, wBar, 2.5);
      }
    }

    // Draw Star Power regions
    for (const sp of currentTrack.starPower) {
      const sSec = tickToTimeSec(sp.tick, bpmMarkers, DEFAULT_RESOLUTION, offsetMs);
      const eSec = tickToTimeSec(sp.tick + sp.duration, bpmMarkers, DEFAULT_RESOLUTION, offsetMs);
      if (eSec < minVisibleSec || sSec > maxVisibleSec) continue;
      const yBottom = timeToY(sSec);
      const yTop = timeToY(eSec);
      ctx.fillStyle = 'rgba(56, 189, 248, 0.12)';
      ctx.fillRect(boardLeft, yTop, boardWidth, Math.max(4, yBottom - yTop));
      ctx.strokeStyle = 'rgba(56, 189, 248, 0.45)';
      ctx.lineWidth = 1;
      ctx.strokeRect(boardLeft + 1, yTop, boardWidth - 2, Math.max(4, yBottom - yTop));
    }

    // Draw Beat & Snap Grid lines
    const startTick = Math.max(0, timeSecToTick(Math.max(0, minVisibleSec), bpmMarkers, DEFAULT_RESOLUTION, offsetMs));
    const endTick = timeSecToTick(Math.max(0, maxVisibleSec), bpmMarkers, DEFAULT_RESOLUTION, offsetMs);
    const snapStep = getGridStepTicks(DEFAULT_RESOLUTION, snapGrid);
    const firstGridTick = Math.floor(startTick / snapStep) * snapStep;

    for (let tick = firstGridTick; tick <= endTick; tick += snapStep) {
      const tSec = tickToTimeSec(tick, bpmMarkers, DEFAULT_RESOLUTION, offsetMs);
      const y = timeToY(tSec);
      if (y < 0 || y > height) continue;

      const isMeasure = tick % (DEFAULT_RESOLUTION * 4) === 0;
      const isBeat = tick % DEFAULT_RESOLUTION === 0;
      const isEighth = tick % (DEFAULT_RESOLUTION / 2) === 0;

      ctx.strokeStyle = isMeasure
        ? 'rgba(248, 250, 252, 0.34)'
        : isBeat
          ? 'rgba(148, 163, 184, 0.24)'
          : isEighth
            ? 'rgba(148, 163, 184, 0.11)'
            : 'rgba(148, 163, 184, 0.05)';
      ctx.lineWidth = isMeasure ? 1.5 : 1;
      ctx.beginPath();
      ctx.moveTo(boardLeft, y);
      ctx.lineTo(boardLeft + boardWidth, y);
      ctx.stroke();

      if (isMeasure) {
        const barNum = Math.floor(tick / (DEFAULT_RESOLUTION * 4)) + 1;
        ctx.fillStyle = '#64748B';
        ctx.font = '500 10px "JetBrains Mono", monospace';
        ctx.fillText(`T${barNum}`, boardLeft + boardWidth + 8, y + 3);
      }
    }

    // Lane dividers & geometry
    if (activeMode === '5fret') {
      const laneW = boardWidth / 5;
      for (let i = 1; i < 5; i++) {
        ctx.strokeStyle = '#1E293B';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(boardLeft + i * laneW, 0);
        ctx.lineTo(boardLeft + i * laneW, height);
        ctx.stroke();
      }
    } else {
      // 6-Fret GHL: 3 paired columns (each split subtly into White left + Black right)
      const colW = boardWidth / 3;
      for (let c = 0; c < 3; c++) {
        const cx = boardLeft + c * colW;
        // Subtle sub-lane divider inside each column
        ctx.strokeStyle = 'rgba(148, 163, 184, 0.12)';
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(cx + colW / 2, 0);
        ctx.lineTo(cx + colW / 2, height);
        ctx.stroke();
        ctx.setLineDash([]);

        if (c > 0) {
          ctx.strokeStyle = '#263145';
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(cx, 0);
          ctx.lineTo(cx, height);
          ctx.stroke();
        }

        // Subtle top column label so 3x2 GHL grouping is unmistakable
        ctx.fillStyle = 'rgba(148, 163, 184, 0.55)';
        ctx.font = '600 10px "Plus Jakarta Sans", sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(`Spalte ${c + 1}`, cx + colW / 2, 16);
      }
      ctx.textAlign = 'left';
    }

    // Strikeline bar
    ctx.fillStyle = 'rgba(245, 158, 11, 0.14)';
    ctx.fillRect(boardLeft, strikeY - 6, boardWidth, 12);
    ctx.strokeStyle = '#F59E0B';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(boardLeft, strikeY);
    ctx.lineTo(boardLeft + boardWidth, strikeY);
    ctx.stroke();

    // Strikeline receptors
    if (activeMode === '5fret') {
      const laneW = boardWidth / 5;
      FIVE_FRET_LANES.forEach((lane, idx) => {
        const cx = boardLeft + idx * laneW + laneW / 2;
        ctx.strokeStyle = lane.color;
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(cx, strikeY, 15, 0, Math.PI * 2);
        ctx.stroke();
      });
    } else {
      const subW = boardWidth / 6;
      GHL_SUBLANES.forEach((sub, idx) => {
        const cx = boardLeft + idx * subW + subW / 2;
        ctx.strokeStyle = sub.isBlack ? '#94A3B8' : '#F8FAFC';
        ctx.fillStyle = sub.isBlack ? '#111827' : '#1E293B';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.roundRect(cx - 14, strikeY - 12, 28, 24, 5);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = sub.isBlack ? '#CBD5E1' : '#FFFFFF';
        ctx.font = '600 10px "JetBrains Mono", monospace';
        ctx.textAlign = 'center';
        ctx.fillText(sub.label, cx, strikeY + 3.5);
      });
      ctx.textAlign = 'left';
    }

    // Group notes by tick for GHL Barre chord bridges
    const visibleNotes = currentTrack.notes.filter((n) => {
      const sSec = tickToTimeSec(n.tick, bpmMarkers, DEFAULT_RESOLUTION, offsetMs);
      const eSec = tickToTimeSec(n.tick + n.sustain, bpmMarkers, DEFAULT_RESOLUTION, offsetMs);
      return eSec >= minVisibleSec - 0.5 && sSec <= maxVisibleSec + 0.5;
    });

    // Draw GHL Barre Chord connectors (when W_k and B_k share the same tick & column)
    if (activeMode === 'ghl') {
      const colW = boardWidth / 3;
      const byTick = new Map<number, ChartNote[]>();
      for (const n of visibleNotes) {
        const arr = byTick.get(n.tick) || [];
        arr.push(n);
        byTick.set(n.tick, arr);
      }
      for (const [tick, tickNotes] of byTick.entries()) {
        const frets = new Set(tickNotes.map((n) => n.fret));
        const y = timeToY(tickToTimeSec(tick, bpmMarkers, DEFAULT_RESOLUTION, offsetMs));
        for (const [colIdx, wFret, bFret] of [
          [0, 'W1', 'B1'],
          [1, 'W2', 'B2'],
          [2, 'W3', 'B3'],
        ] as const) {
          if (frets.has(wFret) && frets.has(bFret)) {
            const x1 = boardLeft + colIdx * colW + colW * 0.25;
            const x2 = boardLeft + colIdx * colW + colW * 0.75;
            ctx.fillStyle = 'rgba(245, 158, 11, 0.35)';
            ctx.fillRect(x1, y - 5, x2 - x1, 10);
          }
        }
      }
    }

    // Draw Notes (Open bars first, then fretted notes)
    const sortedVisible = [...visibleNotes].sort((a, b) =>
      a.fret === 'OPEN' && b.fret !== 'OPEN' ? -1 : a.fret !== 'OPEN' && b.fret === 'OPEN' ? 1 : 0
    );

    const starPowerSet = currentTrack.starPower;
    const isInStarPower = (tick: number) =>
      starPowerSet.some((sp) => tick >= sp.tick && tick <= sp.tick + sp.duration);

    for (const note of sortedVisible) {
      const sSec = tickToTimeSec(note.tick, bpmMarkers, DEFAULT_RESOLUTION, offsetMs);
      const y = timeToY(sSec);
      const isSelected = selectedNoteIds.includes(note.id);
      const spActive = isInStarPower(note.tick);

      if (note.fret === 'OPEN') {
        if (note.sustain > 0) {
          const eSec = tickToTimeSec(note.tick + note.sustain, bpmMarkers, DEFAULT_RESOLUTION, offsetMs);
          const yEnd = timeToY(eSec);
          ctx.fillStyle = spActive ? 'rgba(56, 189, 248, 0.25)' : 'rgba(168, 85, 247, 0.25)';
          ctx.fillRect(boardLeft + 8, yEnd, boardWidth - 16, Math.max(4, y - yEnd));
        }

        ctx.fillStyle = spActive ? '#38BDF8' : '#A855F7';
        ctx.beginPath();
        ctx.roundRect(boardLeft + 8, y - 5, boardWidth - 16, 10, 4);
        ctx.fill();
        if (isSelected) {
          ctx.strokeStyle = '#FFFFFF';
          ctx.lineWidth = 2;
          ctx.stroke();
        }
        continue;
      }

      if (activeMode === '5fret') {
        const laneIdx = FIVE_FRET_LANES.findIndex((l) => l.id === note.fret);
        if (laneIdx < 0) continue;
        const laneW = boardWidth / 5;
        const cx = boardLeft + laneIdx * laneW + laneW / 2;
        const color = spActive ? '#38BDF8' : FIVE_FRET_LANES[laneIdx].color;

        if (note.sustain > 0) {
          const eSec = tickToTimeSec(note.tick + note.sustain, bpmMarkers, DEFAULT_RESOLUTION, offsetMs);
          const yEnd = timeToY(eSec);
          ctx.strokeStyle = color;
          ctx.lineWidth = 6;
          ctx.beginPath();
          ctx.moveTo(cx, y);
          ctx.lineTo(cx, yEnd);
          ctx.stroke();
        }

        // Note gem
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(cx, y, 13, 0, Math.PI * 2);
        ctx.fill();

        // HOPO / Tap / Normal center
        if (note.tap) {
          ctx.fillStyle = '#080B12';
          ctx.beginPath();
          ctx.arc(cx, y, 7, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = '#38BDF8';
          ctx.lineWidth = 2;
          ctx.stroke();
        } else if (note.forced) {
          ctx.fillStyle = '#FFFFFF';
          ctx.beginPath();
          ctx.arc(cx, y, 6, 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.fillStyle = 'rgba(255,255,255,0.28)';
          ctx.beginPath();
          ctx.arc(cx, y, 4.5, 0, Math.PI * 2);
          ctx.fill();
        }

        if (isSelected) {
          ctx.strokeStyle = '#FFFFFF';
          ctx.lineWidth = 2.5;
          ctx.beginPath();
          ctx.arc(cx, y, 16, 0, Math.PI * 2);
          ctx.stroke();
        }
      } else {
        // 6-Fret GHL Note Rendering (Black Plectrum vs White Plectrum)
        const subIdx = GHL_SUBLANES.findIndex((s) => s.id === note.fret);
        if (subIdx < 0) continue;
        const sub = GHL_SUBLANES[subIdx];
        const subW = boardWidth / 6;
        const cx = boardLeft + subIdx * subW + subW / 2;

        const baseColor = spActive ? '#38BDF8' : sub.isBlack ? '#1E293B' : '#F8FAFC';
        const borderColor = spActive ? '#BAE6FD' : sub.isBlack ? '#94A3B8' : '#334155';

        if (note.sustain > 0) {
          const eSec = tickToTimeSec(note.tick + note.sustain, bpmMarkers, DEFAULT_RESOLUTION, offsetMs);
          const yEnd = timeToY(eSec);
          ctx.strokeStyle = spActive ? '#38BDF8' : sub.isBlack ? '#64748B' : '#E2E8F0';
          ctx.lineWidth = 6;
          ctx.beginPath();
          ctx.moveTo(cx, y);
          ctx.lineTo(cx, yEnd);
          ctx.stroke();
        }

        // Draw guitar-pick / plectrum silhouette (Black points UP, White points DOWN)
        ctx.fillStyle = baseColor;
        ctx.strokeStyle = borderColor;
        ctx.lineWidth = 2;
        ctx.beginPath();
        if (sub.isBlack) {
          // Upward dark plectrum
          ctx.moveTo(cx, y - 14);
          ctx.lineTo(cx + 14, y + 6);
          ctx.quadraticCurveTo(cx, y + 13, cx - 14, y + 6);
          ctx.closePath();
        } else {
          // Downward bright white plectrum
          ctx.moveTo(cx - 14, y - 7);
          ctx.quadraticCurveTo(cx, y - 13, cx + 14, y - 7);
          ctx.lineTo(cx, y + 14);
          ctx.closePath();
        }
        ctx.fill();
        ctx.stroke();

        // HOPO / Tap center mark
        if (note.tap) {
          ctx.fillStyle = '#38BDF8';
          ctx.beginPath();
          ctx.arc(cx, y, 4, 0, Math.PI * 2);
          ctx.fill();
        } else if (note.forced) {
          ctx.fillStyle = sub.isBlack ? '#FFFFFF' : '#F59E0B';
          ctx.beginPath();
          ctx.arc(cx, y, 4, 0, Math.PI * 2);
          ctx.fill();
        }

        if (isSelected) {
          ctx.strokeStyle = '#F59E0B';
          ctx.lineWidth = 2.5;
          ctx.beginPath();
          ctx.arc(cx, y, 18, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
    }

    // Live Synced Karaoke Lyric Banner inside Highway Top
    const activeLyric = getActiveLyricDisplay(lyrics, currentTimeSec, bpmMarkers, DEFAULT_RESOLUTION, offsetMs);
    if (activeLyric.phrase) {
      ctx.fillStyle = 'rgba(11, 15, 23, 0.86)';
      ctx.beginPath();
      ctx.roundRect(boardLeft + 16, 14, boardWidth - 32, 38, 8);
      ctx.fill();
      ctx.strokeStyle = '#334155';
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.font = '600 14px "Plus Jakarta Sans", sans-serif';
      ctx.textAlign = 'center';
      const syllables = activeLyric.phrase.syllables;
      const fullStr = syllables
        .map((s, idx) => (s.hyphenated ? `${s.text}-` : idx < syllables.length - 1 ? `${s.text} ` : s.text))
        .join('');
      const totalWidth = ctx.measureText(fullStr).width;
      let cursorX = width / 2 - totalWidth / 2;
      ctx.textAlign = 'left';

      syllables.forEach((syl, idx) => {
        const piece = syl.hyphenated
          ? `${syl.text}-`
          : idx < syllables.length - 1
            ? `${syl.text} `
            : syl.text;
        ctx.fillStyle = idx <= activeLyric.activeSyllableIndex ? '#F59E0B' : '#E2E8F0';
        ctx.fillText(piece, cursorX, 38);
        cursorX += ctx.measureText(piece).width;
      });
    }

    ctx.restore();
  }, [
    activeMode,
    analysis,
    bpmMarkers,
    currentTimeSec,
    currentTrack,
    durationSec,
    lyrics,
    offsetMs,
    pixelsPerSecond,
    selectedNoteIds,
    snapGrid,
  ]);

  // Helper: map canvas click coordinates -> tick & fret
  const canvasPointToTickAndFret = (clientX: number, clientY: number): {tick: number; fret: AnyFretId | null} => {
    const canvas = canvasRef.current;
    if (!canvas) return {tick: 0, fret: null};
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const width = rect.width;
    const height = rect.height;
    const strikeY = height - 74;

    const boardWidth = Math.min(width - 80, activeMode === 'ghl' ? 540 : 520);
    const boardLeft = (width - boardWidth) / 2;

    const clickTimeSec = Math.max(0, currentTimeSec + (strikeY - y) / pixelsPerSecond);
    const rawTick = timeSecToTick(clickTimeSec, bpmMarkers, DEFAULT_RESOLUTION, offsetMs);
    const tick = quantizeTick(rawTick, DEFAULT_RESOLUTION, snapGrid);

    if (x < boardLeft || x > boardLeft + boardWidth) {
      return {tick, fret: null};
    }

    const relX = (x - boardLeft) / boardWidth;
    if (activeMode === '5fret') {
      const idx = Math.min(4, Math.max(0, Math.floor(relX * 5)));
      return {tick, fret: FIVE_FRET_LANES[idx].id};
    } else {
      const idx = Math.min(5, Math.max(0, Math.floor(relX * 6)));
      return {tick, fret: GHL_SUBLANES[idx].id};
    }
  };

  const findNearestNoteAt = (clientX: number, clientY: number): ChartNote | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const width = rect.width;
    const height = rect.height;
    const strikeY = height - 74;
    const boardWidth = Math.min(width - 80, activeMode === 'ghl' ? 540 : 520);
    const boardLeft = (width - boardWidth) / 2;

    let best: ChartNote | null = null;
    let bestDist = 24;

    for (const note of currentTrack.notes) {
      const ny =
        strikeY -
        (tickToTimeSec(note.tick, bpmMarkers, DEFAULT_RESOLUTION, offsetMs) - currentTimeSec) *
          pixelsPerSecond;
      if (Math.abs(ny - y) > 20) continue;

      if (note.fret === 'OPEN') {
        if (x >= boardLeft && x <= boardLeft + boardWidth) {
          const d = Math.abs(ny - y);
          if (d < bestDist) {
            bestDist = d;
            best = note;
          }
        }
        continue;
      }

      let nx = boardLeft;
      if (activeMode === '5fret') {
        const idx = FIVE_FRET_LANES.findIndex((l) => l.id === note.fret);
        if (idx < 0) continue;
        const laneW = boardWidth / 5;
        nx = boardLeft + idx * laneW + laneW / 2;
      } else {
        const idx = GHL_SUBLANES.findIndex((s) => s.id === note.fret);
        if (idx < 0) continue;
        const subW = boardWidth / 6;
        nx = boardLeft + idx * subW + subW / 2;
      }

      const dist = Math.hypot(nx - x, ny - y);
      if (dist < bestDist) {
        bestDist = dist;
        best = note;
      }
    }
    return best;
  };

  const toggleNoteAt = (tick: number, fret: AnyFretId) => {
    const existing = currentTrack.notes.find((n) => n.tick === tick && n.fret === fret);
    let nextNotes: ChartNote[];
    if (existing) {
      nextNotes = currentTrack.notes.filter((n) => n.id !== existing.id);
      setSelectedNoteIds((ids) => ids.filter((id) => id !== existing.id));
    } else {
      // Prevent mixing OPEN with fretted notes at the exact same tick
      const filtered =
        fret === 'OPEN'
          ? currentTrack.notes.filter((n) => n.tick !== tick)
          : currentTrack.notes.filter((n) => !(n.tick === tick && n.fret === 'OPEN'));

      const created: ChartNote = {
        id: `manual-${activeMode}-${tick}-${fret}-${Date.now()}`,
        tick,
        fret,
        sustain: 0,
        forced: false,
        tap: false,
      };
      nextNotes = [...filtered, created].sort((a, b) => a.tick - b.tick);
      setSelectedNoteIds([created.id]);
    }
    onUpdateTrack(activeMode, activeDifficulty, {...currentTrack, notes: nextNotes});
  };

  const deleteSelectedNotes = () => {
    if (selectedNoteIds.length === 0) return;
    const nextNotes = currentTrack.notes.filter((n) => !selectedNoteIds.includes(n.id));
    setSelectedNoteIds([]);
    onUpdateTrack(activeMode, activeDifficulty, {...currentTrack, notes: nextNotes});
  };

  const handleCanvasMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!hasAudio) return;
    const hit = findNearestNoteAt(e.clientX, e.clientY);
    const {tick, fret} = canvasPointToTickAndFret(e.clientX, e.clientY);

    if (e.button === 2 && hit) {
      e.preventDefault();
      onUpdateTrack(activeMode, activeDifficulty, {
        ...currentTrack,
        notes: currentTrack.notes.filter((n) => n.id !== hit.id),
      });
      setSelectedNoteIds((ids) => ids.filter((id) => id !== hit.id));
      return;
    }

    if (tool === 'erase') {
      if (hit) {
        onUpdateTrack(activeMode, activeDifficulty, {
          ...currentTrack,
          notes: currentTrack.notes.filter((n) => n.id !== hit.id),
        });
        setSelectedNoteIds((ids) => ids.filter((id) => id !== hit.id));
      }
      return;
    }

    if (tool === 'starpower') {
      spDragStartTickRef.current = tick;
      return;
    }

    if (tool === 'add') {
      if (hit) {
        setSelectedNoteIds([hit.id]);
      } else if (fret) {
        toggleNoteAt(tick, fret);
      }
      return;
    }

    // Select tool
    if (hit) {
      setSelectedNoteIds([hit.id]);
      noteDragRef.current = {noteId: hit.id, origTick: hit.tick, startY: e.clientY};
    } else {
      setSelectedNoteIds([]);
    }
  };

  const handleCanvasMouseUp = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (tool === 'starpower' && spDragStartTickRef.current !== null) {
      const {tick: endTick} = canvasPointToTickAndFret(e.clientX, e.clientY);
      const start = Math.min(spDragStartTickRef.current, endTick);
      const end = Math.max(spDragStartTickRef.current, endTick);
      const duration = Math.max(DEFAULT_RESOLUTION * 2, end - start);
      const nextSp = [
        ...currentTrack.starPower,
        {id: `sp-manual-${Date.now()}`, tick: start, duration},
      ].sort((a, b) => a.tick - b.tick);
      onUpdateTrack(activeMode, activeDifficulty, {...currentTrack, starPower: nextSp});
      spDragStartTickRef.current = null;
      return;
    }

    if (noteDragRef.current) {
      const drag = noteDragRef.current;
      noteDragRef.current = null;
      const dy = drag.startY - e.clientY;
      if (Math.abs(dy) > 6) {
        const dtSec = dy / pixelsPerSecond;
        const origSec = tickToTimeSec(drag.origTick, bpmMarkers, DEFAULT_RESOLUTION, offsetMs);
        const rawNewTick = timeSecToTick(Math.max(0, origSec + dtSec), bpmMarkers, DEFAULT_RESOLUTION, offsetMs);
        const snappedTick = quantizeTick(rawNewTick, DEFAULT_RESOLUTION, snapGrid);
        const nextNotes = currentTrack.notes
          .map((n) => (n.id === drag.noteId ? {...n, tick: snappedTick} : n))
          .sort((a, b) => a.tick - b.tick);
        onUpdateTrack(activeMode, activeDifficulty, {...currentTrack, notes: nextNotes});
      }
    }
  };

  const handleWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    if (!hasAudio) return;
    const stepSec = (e.deltaY / pixelsPerSecond) * -0.5;
    onSeek(Math.min(durationSec, Math.max(0, currentTimeSec + stepSec)));
  };

  const adjustSelectedNotes = (updater: (n: ChartNote) => ChartNote) => {
    if (selectedNoteIds.length === 0) return;
    const nextNotes = currentTrack.notes.map((n) =>
      selectedNoteIds.includes(n.id) ? updater(n) : n
    );
    onUpdateTrack(activeMode, activeDifficulty, {...currentTrack, notes: nextNotes});
  };

  const chartPreviewSnippet = useMemo(() => {
    const full = serializeChartFile({
      metadata,
      bpmMarkers,
      lyrics,
      tracks,
      offsetMs,
      resolution: DEFAULT_RESOLUTION,
    });
    const sectionHeader =
      activeMode === 'ghl' ? `[${activeDifficulty}GHLGuitar]` : `[${activeDifficulty}Single]`;
    const idx = full.indexOf(sectionHeader);
    if (idx >= 0) {
      return full.slice(idx, idx + 2200);
    }
    return full.slice(0, 2200);
  }, [activeDifficulty, activeMode, bpmMarkers, lyrics, metadata, offsetMs, tracks]);

  const songIniSnippet = useMemo(
    () => serializeSongIni(metadata, durationSec || 24, Boolean(videoUrl)),
    [metadata, durationSec, videoUrl]
  );

  const uniqueNotes = getUniqueNoteCount(currentTrack.notes);

  return (
    <div className="mx-auto max-w-[1440px] space-y-4 px-6 py-5">
      {/* Editor Top Control Strip */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#263145] bg-[#131924] px-4 py-3">
        {/* Mode + Difficulty */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1 rounded-lg bg-[#0B0F17] p-1">
            <button
              type="button"
              onClick={() => {
                onSelectMode('ghl');
                setSelectedNoteIds([]);
              }}
              className={`whitespace-nowrap rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${
                activeMode === 'ghl' ? 'bg-amber-500 text-slate-950' : 'text-slate-400 hover:text-white'
              }`}
            >
              6-Bund GHL
            </button>
            <button
              type="button"
              onClick={() => {
                onSelectMode('5fret');
                setSelectedNoteIds([]);
              }}
              className={`whitespace-nowrap rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${
                activeMode === '5fret' ? 'bg-amber-500 text-slate-950' : 'text-slate-400 hover:text-white'
              }`}
            >
              5-Fret
            </button>
          </div>

          <div className="flex items-center gap-1 rounded-lg bg-[#0B0F17] p-1">
            {DIFFICULTIES.map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => {
                  onSelectDifficulty(d);
                  setSelectedNoteIds([]);
                }}
                className={`whitespace-nowrap rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors ${
                  activeDifficulty === d
                    ? 'bg-[#1B2332] text-white'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {d}
              </button>
            ))}
          </div>

          <span className="font-mono-tabular text-xs text-slate-400">
            {uniqueNotes} Anschläge · {currentTrack.starPower.length} Star Power
          </span>
        </div>

        {/* Editing Tools */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1 rounded-lg bg-[#0B0F17] p-1">
            <button
              type="button"
              onClick={() => setTool('select')}
              title="Auswählen / Verschieben"
              className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1.5 text-xs font-medium ${
                tool === 'select' ? 'bg-[#1B2332] text-amber-400' : 'text-slate-400 hover:text-white'
              }`}
            >
              <MousePointer className="h-3.5 w-3.5" />
              Auswahl
            </button>
            <button
              type="button"
              onClick={() => setTool('add')}
              title="Note per Klick setzen"
              className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1.5 text-xs font-medium ${
                tool === 'add' ? 'bg-[#1B2332] text-amber-400' : 'text-slate-400 hover:text-white'
              }`}
            >
              <Pencil className="h-3.5 w-3.5" />
              Setzen
            </button>
            <button
              type="button"
              onClick={() => setTool('erase')}
              title="Noten per Klick löschen"
              className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1.5 text-xs font-medium ${
                tool === 'erase' ? 'bg-[#1B2332] text-red-400' : 'text-slate-400 hover:text-white'
              }`}
            >
              <Eraser className="h-3.5 w-3.5" />
              Radierer
            </button>
            <button
              type="button"
              onClick={() => setTool('starpower')}
              title="Star-Power-Bereich ziehen"
              className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1.5 text-xs font-medium ${
                tool === 'starpower' ? 'bg-[#1B2332] text-sky-400' : 'text-slate-400 hover:text-white'
              }`}
            >
              <Zap className="h-3.5 w-3.5" />
              Star Power
            </button>
          </div>

          <select
            aria-label="Snap-Raster"
            value={snapGrid}
            onChange={(e) => setSnapGrid(Number(e.target.value) as QuantizeGrid)}
            className="rounded-lg border border-[#334155] bg-[#0B0F17] px-2.5 py-1.5 text-xs text-slate-200 focus:border-amber-500 focus:outline-none"
          >
            <option value={4}>Raster 1/4</option>
            <option value={8}>Raster 1/8</option>
            <option value={12}>Raster 1/12</option>
            <option value={16}>Raster 1/16</option>
            <option value={24}>Raster 1/24</option>
            <option value={32}>Raster 1/32</option>
          </select>

          <button
            type="button"
            disabled={!canUndo}
            onClick={onUndo}
            aria-label="Rückgängig"
            title="Rückgängig (Strg+Z)"
            className="rounded-lg border border-[#334155] bg-[#0B0F17] p-2 text-slate-300 hover:text-white disabled:opacity-35"
          >
            <Undo2 className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            disabled={!canRedo}
            onClick={onRedo}
            aria-label="Wiederholen"
            title="Wiederholen (Strg+Y)"
            className="rounded-lg border border-[#334155] bg-[#0B0F17] p-2 text-slate-300 hover:text-white disabled:opacity-35"
          >
            <Redo2 className="h-3.5 w-3.5" />
          </button>

          <button
            type="button"
            onClick={() => setShowCodePanel((v) => !v)}
            className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg border px-3 py-1.5 text-xs font-medium ${
              showCodePanel
                ? 'border-amber-500 bg-amber-500/15 text-amber-300'
                : 'border-[#334155] bg-[#0B0F17] text-slate-300 hover:text-white'
            }`}
          >
            <Code2 className="h-3.5 w-3.5" />
            .chart / .ini
          </button>
        </div>
      </div>

      {/* Main Editor Stage */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        {/* Left/Center: Highway Canvas + Transport */}
        <div className={`${showCodePanel ? 'lg:col-span-8' : 'lg:col-span-9'} space-y-3`}>
          <div className="relative overflow-hidden rounded-xl border border-[#263145] bg-[#080B12]">
            {/* Optional MP4 background video synced behind / PiP */}
            {videoUrl && (
              <video
                ref={videoRef}
                src={videoUrl}
                muted
                playsInline
                className="pointer-events-none absolute inset-0 h-full w-full object-cover opacity-20"
              />
            )}

            <canvas
              ref={canvasRef}
              data-testid="highway-canvas"
              onMouseDown={handleCanvasMouseDown}
              onMouseUp={handleCanvasMouseUp}
              onWheel={handleWheel}
              onContextMenu={(e) => e.preventDefault()}
              className="relative z-10 block h-[520px] w-full cursor-crosshair"
            />

            {!hasAudio && (
              <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-[#080B12]/80 px-6 text-center">
                <Sparkles className="h-8 w-8 text-amber-400" />
                <p className="mt-2 font-display text-base font-semibold text-slate-100">
                  Noch kein Song geladen
                </p>
                <p className="mt-1 text-xs text-slate-400">
                  Lade im Tab „Analyse & Tags“ eine MP3/MP4 oder den Demo-Song, um Noten zu bearbeiten.
                </p>
              </div>
            )}
          </div>

          {/* Transport Bar */}
          <div className="flex flex-wrap items-center gap-3 rounded-xl border border-[#263145] bg-[#131924] px-4 py-2.5">
            <button
              type="button"
              disabled={!hasAudio}
              onClick={onTogglePlay}
              className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg bg-amber-500 px-3.5 py-1.5 text-xs font-semibold text-slate-950 hover:bg-amber-400 disabled:opacity-40"
            >
              {isPlaying ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
              {isPlaying ? 'Pause' : 'Playtest'}
            </button>
            <button
              type="button"
              disabled={!hasAudio}
              onClick={onStop}
              aria-label="Stopp und zurück zum Anfang"
              className="rounded-lg border border-[#334155] bg-[#1B2332] p-1.5 text-slate-300 hover:text-white disabled:opacity-40"
            >
              <Square className="h-3.5 w-3.5" />
            </button>

            <span className="font-mono-tabular text-xs font-semibold text-amber-400">
              {formatTimecode(currentTimeSec)}
            </span>

            <input
              type="range"
              min={0}
              max={Math.max(1, durationSec || 24)}
              step={0.02}
              value={currentTimeSec}
              disabled={!hasAudio}
              aria-label="Playhead Position"
              onChange={(e) => onSeek(Number(e.target.value))}
              className="min-w-[140px] flex-1 accent-amber-500"
            />

            <span className="font-mono-tabular text-xs text-slate-400">
              {formatTimecode(durationSec || 0)} · Tick{' '}
              {timeSecToTick(currentTimeSec, bpmMarkers, DEFAULT_RESOLUTION, offsetMs)}
            </span>

            <div className="flex items-center gap-2 border-l border-[#263145] pl-3">
              <label htmlFor="highway-zoom" className="text-xs text-slate-400">
                Zoom
              </label>
              <input
                id="highway-zoom"
                type="range"
                min={110}
                max={420}
                step={10}
                value={pixelsPerSecond}
                onChange={(e) => setPixelsPerSecond(Number(e.target.value))}
                className="w-20 accent-amber-500"
              />
            </div>
          </div>
        </div>

        {/* Right Side Panel: Selected Note Inspector + Quick Open/GHL Pad OR .chart Code */}
        <aside className={`${showCodePanel ? 'lg:col-span-4' : 'lg:col-span-3'} space-y-4`}>
          {/* Quick Fret Placement at Playhead */}
          <div className="rounded-xl border border-[#263145] bg-[#131924] p-4">
            <h3 className="text-sm font-semibold text-slate-100">
              Schnell-Eingabe am Playhead
            </h3>
            <p className="mt-0.5 text-xs text-slate-400">
              Klicke oder nutze Tasten {activeMode === 'ghl' ? '1–6 + 7 (Open)' : '1–5 + 7 (Open)'}.
            </p>

            {activeMode === 'ghl' ? (
              <div className="mt-3 space-y-2">
                <div className="grid grid-cols-3 gap-1.5">
                  {(['B1', 'B2', 'B3'] as AnyFretId[]).map((fret, idx) => (
                    <button
                      key={fret}
                      type="button"
                      disabled={!hasAudio}
                      onClick={() => {
                        const tick = quantizeTick(
                          timeSecToTick(currentTimeSec, bpmMarkers, DEFAULT_RESOLUTION, offsetMs),
                          DEFAULT_RESOLUTION,
                          snapGrid
                        );
                        toggleNoteAt(tick, fret);
                      }}
                      className="rounded-md border border-slate-500 bg-[#0B0F17] py-2 text-xs font-semibold text-slate-200 hover:border-amber-400 disabled:opacity-40"
                    >
                      {fret} ({idx + 4})
                    </button>
                  ))}
                  {(['W1', 'W2', 'W3'] as AnyFretId[]).map((fret, idx) => (
                    <button
                      key={fret}
                      type="button"
                      disabled={!hasAudio}
                      onClick={() => {
                        const tick = quantizeTick(
                          timeSecToTick(currentTimeSec, bpmMarkers, DEFAULT_RESOLUTION, offsetMs),
                          DEFAULT_RESOLUTION,
                          snapGrid
                        );
                        toggleNoteAt(tick, fret);
                      }}
                      className="rounded-md border border-slate-300 bg-slate-100 py-2 text-xs font-semibold text-slate-900 hover:bg-amber-100 disabled:opacity-40"
                    >
                      {fret} ({idx + 1})
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  disabled={!hasAudio}
                  onClick={() => {
                    const tick = quantizeTick(
                      timeSecToTick(currentTimeSec, bpmMarkers, DEFAULT_RESOLUTION, offsetMs),
                      DEFAULT_RESOLUTION,
                      snapGrid
                    );
                    toggleNoteAt(tick, 'OPEN');
                  }}
                  className="w-full rounded-md border border-purple-500/60 bg-purple-500/15 py-1.5 text-xs font-semibold text-purple-200 hover:bg-purple-500/25 disabled:opacity-40"
                >
                  Open Strum (7)
                </button>
              </div>
            ) : (
              <div className="mt-3 space-y-2">
                <div className="grid grid-cols-5 gap-1.5">
                  {FIVE_FRET_LANES.map((lane, idx) => (
                    <button
                      key={lane.id}
                      type="button"
                      disabled={!hasAudio}
                      onClick={() => {
                        const tick = quantizeTick(
                          timeSecToTick(currentTimeSec, bpmMarkers, DEFAULT_RESOLUTION, offsetMs),
                          DEFAULT_RESOLUTION,
                          snapGrid
                        );
                        toggleNoteAt(tick, lane.id);
                      }}
                      style={{borderColor: lane.color}}
                      className="rounded-md border bg-[#0B0F17] py-2 text-xs font-semibold text-slate-100 hover:bg-[#1B2332] disabled:opacity-40"
                    >
                      {lane.id} ({idx + 1})
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  disabled={!hasAudio}
                  onClick={() => {
                    const tick = quantizeTick(
                      timeSecToTick(currentTimeSec, bpmMarkers, DEFAULT_RESOLUTION, offsetMs),
                      DEFAULT_RESOLUTION,
                      snapGrid
                    );
                    toggleNoteAt(tick, 'OPEN');
                  }}
                  className="w-full rounded-md border border-purple-500/60 bg-purple-500/15 py-1.5 text-xs font-semibold text-purple-200 hover:bg-purple-500/25 disabled:opacity-40"
                >
                  Open Strum (7)
                </button>
              </div>
            )}
          </div>

          {/* Selected Note Properties */}
          <div className="rounded-xl border border-[#263145] bg-[#131924] p-4">
            <h3 className="text-sm font-semibold text-slate-100">Noten-Eigenschaften</h3>
            {selectedNotes.length === 0 ? (
              <p className="mt-2 text-xs text-slate-400">
                Klicke im Highway auf eine Note, um Timing, Sustain, Forced HOPO oder Tap anzupassen.
              </p>
            ) : (
              <div className="mt-3 space-y-3">
                <div className="flex items-center justify-between gap-2 text-xs text-slate-300">
                  <span className="font-semibold text-amber-400">
                    {getFretDisplayLabel(selectedNotes[0].fret)}
                  </span>
                  <span className="font-mono-tabular text-slate-400">
                    {formatTimecode(
                      tickToTimeSec(selectedNotes[0].tick, bpmMarkers, DEFAULT_RESOLUTION, offsetMs)
                    )}
                  </span>
                </div>

                <div>
                  <label htmlFor="selected-note-tick" className="block text-xs text-slate-400">
                    Position (Tick) & Timing-Feinschritt
                  </label>
                  <div className="mt-1.5 flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() =>
                        adjustSelectedNotes((n) => ({
                          ...n,
                          tick: Math.max(0, n.tick - getGridStepTicks(DEFAULT_RESOLUTION, snapGrid)),
                        }))
                      }
                      className="rounded-md border border-[#334155] bg-[#0B0F17] px-2 py-1 text-xs text-slate-200 hover:border-amber-500/60"
                    >
                      -{snapGrid === 4 ? '1/4' : `1/${snapGrid}`}
                    </button>
                    <input
                      id="selected-note-tick"
                      type="number"
                      min={0}
                      step={12}
                      value={selectedNotes[0].tick}
                      onChange={(e) => {
                        const val = Math.max(0, Math.round(Number(e.target.value) || 0));
                        adjustSelectedNotes((n) => ({...n, tick: val}));
                      }}
                      className="font-mono-tabular min-w-0 flex-1 rounded-md border border-[#334155] bg-[#0B0F17] px-2 py-1 text-xs text-slate-100 focus:border-amber-500 focus:outline-none"
                    />
                    <button
                      type="button"
                      onClick={() =>
                        adjustSelectedNotes((n) => ({
                          ...n,
                          tick: n.tick + getGridStepTicks(DEFAULT_RESOLUTION, snapGrid),
                        }))
                      }
                      className="rounded-md border border-[#334155] bg-[#0B0F17] px-2 py-1 text-xs text-slate-200 hover:border-amber-500/60"
                    >
                      +{snapGrid === 4 ? '1/4' : `1/${snapGrid}`}
                    </button>
                  </div>
                </div>

                <div>
                  <span className="block text-xs text-slate-400">
                    Sustain-Länge: <span className="font-mono-tabular text-slate-200">{selectedNotes[0].sustain} Ticks</span>
                  </span>
                  <div className="mt-1.5 flex gap-2">
                    <button
                      type="button"
                      onClick={() =>
                        adjustSelectedNotes((n) => ({
                          ...n,
                          sustain: Math.max(0, n.sustain - 48),
                        }))
                      }
                      className="flex-1 rounded-md border border-[#334155] bg-[#0B0F17] py-1.5 text-xs text-slate-200 hover:border-amber-500/60"
                    >
                      - 1/16
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        adjustSelectedNotes((n) => ({
                          ...n,
                          sustain: n.sustain + 48,
                        }))
                      }
                      className="flex-1 rounded-md border border-[#334155] bg-[#0B0F17] py-1.5 text-xs text-slate-200 hover:border-amber-500/60"
                    >
                      + 1/16
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      adjustSelectedNotes((n) => ({...n, forced: !n.forced, tap: false}))
                    }
                    className={`rounded-md border py-1.5 text-xs font-medium ${
                      selectedNotes[0].forced
                        ? 'border-amber-400 bg-amber-500/20 text-amber-300'
                        : 'border-[#334155] bg-[#0B0F17] text-slate-300'
                    }`}
                  >
                    Forced HOPO
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      adjustSelectedNotes((n) => ({...n, tap: !n.tap, forced: false}))
                    }
                    className={`rounded-md border py-1.5 text-xs font-medium ${
                      selectedNotes[0].tap
                        ? 'border-sky-400 bg-sky-500/20 text-sky-300'
                        : 'border-[#334155] bg-[#0B0F17] text-slate-300'
                    }`}
                  >
                    Tap-Note
                  </button>
                </div>

                <button
                  type="button"
                  onClick={deleteSelectedNotes}
                  className="inline-flex w-full items-center justify-center gap-1.5 rounded-md border border-red-500/40 bg-red-500/10 py-1.5 text-xs font-medium text-red-300 hover:bg-red-500/20"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Note löschen
                </button>
              </div>
            )}
          </div>

          {/* Live .chart / song.ini Inspector */}
          {showCodePanel && (
            <div className="rounded-xl border border-[#263145] bg-[#131924] p-4">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-semibold text-slate-100">
                  Live .chart & song.ini
                </h3>
                <div className="flex gap-1.5">
                  <button
                    type="button"
                    onClick={onDownloadChartOnly}
                    className="inline-flex items-center gap-1 rounded border border-[#334155] bg-[#1B2332] px-2 py-1 text-[11px] text-amber-400 hover:text-amber-300"
                  >
                    <Download className="h-3 w-3" />
                    .chart
                  </button>
                  <button
                    type="button"
                    onClick={onDownloadIniOnly}
                    className="inline-flex items-center gap-1 rounded border border-[#334155] bg-[#1B2332] px-2 py-1 text-[11px] text-amber-400 hover:text-amber-300"
                  >
                    <Download className="h-3 w-3" />
                    .ini
                  </button>
                </div>
              </div>
              <pre className="font-mono-tabular mt-2 max-h-48 overflow-auto rounded-lg border border-[#263145] bg-[#0B0F17] p-2.5 text-[11px] leading-relaxed text-slate-300">
                {chartPreviewSnippet}
              </pre>
              <pre className="font-mono-tabular mt-2 max-h-36 overflow-auto rounded-lg border border-[#263145] bg-[#0B0F17] p-2.5 text-[11px] leading-relaxed text-slate-400">
                {songIniSnippet}
              </pre>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
};
