import React from 'react';
import {RefreshCw, RotateCcw} from 'lucide-react';
import type {
  Difficulty,
  DifficultyConfig,
  DifficultyConfigMap,
  InstrumentMode,
  QuantizeGrid,
} from '../types/chart';
import {DIFFICULTIES, DIFFICULTY_LABELS} from '../utils/difficultyPresets';

interface AdvancedSettingsViewProps {
  hasAudio: boolean;
  activeMode: InstrumentMode;
  activeDifficulty: Difficulty;
  configs: DifficultyConfigMap;
  onSelectMode: (mode: InstrumentMode) => void;
  onSelectDifficulty: (diff: Difficulty) => void;
  onUpdateConfig: (mode: InstrumentMode, diff: Difficulty, patch: Partial<DifficultyConfig>) => void;
  onRegenerateSingle: (mode: InstrumentMode, diff: Difficulty) => void;
  onRegenerateAll: () => void;
  onResetDefaults: () => void;
}

const QUANTIZE_OPTIONS: {value: QuantizeGrid; label: string}[] = [
  {value: 4, label: '1/4 (Viertel)'},
  {value: 8, label: '1/8 (Achtel)'},
  {value: 12, label: '1/12 (Triolen)'},
  {value: 16, label: '1/16 (Sechzehntel)'},
  {value: 24, label: '1/24 (16tel-Triolen)'},
  {value: 32, label: '1/32 (Zweiunddreißigstel)'},
];

export const AdvancedSettingsView: React.FC<AdvancedSettingsViewProps> = ({
  hasAudio,
  activeMode,
  activeDifficulty,
  configs,
  onSelectMode,
  onSelectDifficulty,
  onUpdateConfig,
  onRegenerateSingle,
  onRegenerateAll,
  onResetDefaults,
}) => {
  const modeKey = activeMode === '5fret' ? 'fiveFret' : 'ghl';
  const cfg = configs[modeKey][activeDifficulty];

  const update = (patch: Partial<DifficultyConfig>) => {
    onUpdateConfig(activeMode, activeDifficulty, patch);
  };

  return (
    <div className="mx-auto max-w-[1280px] space-y-6 px-6 py-6">
      {/* Header & Mode / Difficulty Selectors */}
      <section className="rounded-xl border border-[#263145] bg-[#131924] p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="font-display text-xl font-semibold text-slate-100">
              Fortgeschrittene Algorithmus-Parameter
            </h2>
            <p className="mt-1 text-sm text-slate-400">
              Feinabstimmung für jede Schwierigkeitsstufe — getrennt für 6-Bund GHL und 5-Fret Standard.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              onClick={onResetDefaults}
              className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-[#334155] bg-[#1B2332] px-3.5 py-2 text-xs font-medium text-slate-300 hover:text-white"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Standardwerte
            </button>
            <button
              type="button"
              disabled={!hasAudio}
              onClick={() => onRegenerateSingle(activeMode, activeDifficulty)}
              className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg bg-amber-500 px-4 py-2 text-xs font-semibold text-slate-950 hover:bg-amber-400 disabled:opacity-40"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Aktuelle Stufe neu generieren
            </button>
            <button
              type="button"
              disabled={!hasAudio}
              onClick={onRegenerateAll}
              className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-[#334155] bg-[#1B2332] px-3.5 py-2 text-xs font-medium text-slate-200 hover:border-amber-500/60 hover:text-white disabled:opacity-40"
            >
              Alle 8 Spuren neu generieren
            </button>
          </div>
        </div>

        {/* Mode & Difficulty Switcher */}
        <div className="mt-5 flex flex-wrap items-center gap-4 border-t border-[#263145] pt-4">
          <div className="flex items-center gap-1 rounded-lg bg-[#0B0F17] p-1">
            <button
              type="button"
              onClick={() => onSelectMode('ghl')}
              className={`whitespace-nowrap rounded-md px-3.5 py-1.5 text-xs font-semibold transition-colors ${
                activeMode === 'ghl'
                  ? 'bg-amber-500 text-slate-950'
                  : 'text-slate-400 hover:text-slate-100'
              }`}
            >
              6-Bund GHL (Guitar Hero Live)
            </button>
            <button
              type="button"
              onClick={() => onSelectMode('5fret')}
              className={`whitespace-nowrap rounded-md px-3.5 py-1.5 text-xs font-semibold transition-colors ${
                activeMode === '5fret'
                  ? 'bg-amber-500 text-slate-950'
                  : 'text-slate-400 hover:text-slate-100'
              }`}
            >
              5-Fret Standard Guitar
            </button>
          </div>

          <div className="flex items-center gap-1 rounded-lg bg-[#0B0F17] p-1">
            {DIFFICULTIES.map((diff) => (
              <button
                key={diff}
                type="button"
                onClick={() => onSelectDifficulty(diff)}
                className={`whitespace-nowrap rounded-md px-3.5 py-1.5 text-xs font-medium transition-colors ${
                  activeDifficulty === diff
                    ? 'bg-[#1B2332] text-white'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {DIFFICULTY_LABELS[diff]}
              </button>
            ))}
          </div>
        </div>
      </section>

      {/* Parameter Grid */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Rhythmic Density & Quantization */}
        <section className="rounded-xl border border-[#263145] bg-[#131924] p-5">
          <h3 className="font-display text-base font-semibold text-slate-100">
            Rhythmus, Dichte & Quantisierung
          </h3>
          <div className="mt-4 space-y-4">
            <div>
              <div className="flex justify-between text-xs">
                <label htmlFor="cfg-spacing" className="font-medium text-slate-300">
                  Mindestabstand zwischen Noten
                </label>
                <span className="font-mono-tabular text-amber-400">{cfg.minSpacingMs} ms</span>
              </div>
              <input
                id="cfg-spacing"
                type="range"
                min={55}
                max={600}
                step={5}
                value={cfg.minSpacingMs}
                onChange={(e) => update({minSpacingMs: Number(e.target.value)})}
                className="mt-1.5 w-full accent-amber-500"
              />
            </div>

            <div>
              <div className="flex justify-between text-xs">
                <label htmlFor="cfg-sensitivity" className="font-medium text-slate-300">
                  Onset-Empfindlichkeit (Peak-Erkennung)
                </label>
                <span className="font-mono-tabular text-amber-400">
                  {Math.round(cfg.onsetSensitivity * 100)}%
                </span>
              </div>
              <input
                id="cfg-sensitivity"
                type="range"
                min={15}
                max={95}
                step={1}
                value={Math.round(cfg.onsetSensitivity * 100)}
                onChange={(e) => update({onsetSensitivity: Number(e.target.value) / 100})}
                className="mt-1.5 w-full accent-amber-500"
              />
            </div>

            <div>
              <label htmlFor="cfg-quantize" className="block text-xs font-medium text-slate-300">
                Takt-Quantisierungsraster
              </label>
              <select
                id="cfg-quantize"
                value={cfg.quantizeGrid}
                onChange={(e) => update({quantizeGrid: Number(e.target.value) as QuantizeGrid})}
                className="mt-1.5 w-full rounded-lg border border-[#334155] bg-[#0B0F17] px-3 py-2 text-sm text-slate-100 focus:border-amber-500 focus:outline-none"
              >
                {QUANTIZE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <div className="flex justify-between text-xs">
                <label htmlFor="cfg-sustain" className="font-medium text-slate-300">
                  Sustain-Empfindlichkeit (gehaltene Töne)
                </label>
                <span className="font-mono-tabular text-amber-400">
                  {Math.round(cfg.sustainSensitivity * 100)}%
                </span>
              </div>
              <input
                id="cfg-sustain"
                type="range"
                min={0}
                max={100}
                step={5}
                value={Math.round(cfg.sustainSensitivity * 100)}
                onChange={(e) => update({sustainSensitivity: Number(e.target.value) / 100})}
                className="mt-1.5 w-full accent-amber-500"
              />
            </div>

            <div>
              <div className="flex justify-between text-xs">
                <label htmlFor="cfg-starpower" className="font-medium text-slate-300">
                  Star-Power-Phrasen Dichte
                </label>
                <span className="font-mono-tabular text-amber-400">
                  {Math.round(cfg.starPowerDensity * 100)}%
                </span>
              </div>
              <input
                id="cfg-starpower"
                type="range"
                min={0}
                max={100}
                step={5}
                value={Math.round(cfg.starPowerDensity * 100)}
                onChange={(e) => update({starPowerDensity: Number(e.target.value) / 100})}
                className="mt-1.5 w-full accent-amber-500"
              />
            </div>
          </div>
        </section>

        {/* Chords, Techniques & 6-Fret GHL Ergonomics */}
        <section className="rounded-xl border border-[#263145] bg-[#131924] p-5">
          <h3 className="font-display text-base font-semibold text-slate-100">
            {activeMode === 'ghl'
              ? '6-Bund GHL Spielmechanik & Akkorde'
              : '5-Fret Spielmechanik & Akkorde'}
          </h3>

          <div className="mt-4 space-y-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <div className="flex justify-between text-xs">
                  <label htmlFor="cfg-chords" className="font-medium text-slate-300">
                    Akkord-Anteil
                  </label>
                  <span className="font-mono-tabular text-amber-400">
                    {Math.round(cfg.chordProbability * 100)}%
                  </span>
                </div>
                <input
                  id="cfg-chords"
                  type="range"
                  min={0}
                  max={100}
                  step={2}
                  value={Math.round(cfg.chordProbability * 100)}
                  onChange={(e) => update({chordProbability: Number(e.target.value) / 100})}
                  className="mt-1.5 w-full accent-amber-500"
                />
              </div>

              <div>
                <label htmlFor="cfg-max-chord" className="block text-xs font-medium text-slate-300">
                  Max. Noten pro Akkord
                </label>
                <select
                  id="cfg-max-chord"
                  value={cfg.maxChordSize}
                  onChange={(e) => update({maxChordSize: Number(e.target.value) as 1 | 2 | 3})}
                  className="mt-1.5 w-full rounded-lg border border-[#334155] bg-[#0B0F17] px-3 py-1.5 text-sm text-slate-100 focus:border-amber-500 focus:outline-none"
                >
                  <option value={1}>1 (Nur Einzelnoten)</option>
                  <option value={2}>2 (Powerchords / Barre)</option>
                  <option value={3}>3 (Vollakkorde)</option>
                </select>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div>
                <div className="flex justify-between text-xs">
                  <label htmlFor="cfg-open" className="font-medium text-slate-300">
                    Open-Notes
                  </label>
                  <span className="font-mono-tabular text-amber-400">
                    {Math.round(cfg.openNoteRate * 100)}%
                  </span>
                </div>
                <input
                  id="cfg-open"
                  type="range"
                  min={0}
                  max={45}
                  step={1}
                  value={Math.round(cfg.openNoteRate * 100)}
                  onChange={(e) => update({openNoteRate: Number(e.target.value) / 100})}
                  className="mt-1.5 w-full accent-amber-500"
                />
              </div>

              <div>
                <div className="flex justify-between text-xs">
                  <label htmlFor="cfg-hopo" className="font-medium text-slate-300">
                    HOPO-Fenster
                  </label>
                  <span className="font-mono-tabular text-amber-400">{cfg.hopoThresholdMs} ms</span>
                </div>
                <input
                  id="cfg-hopo"
                  type="range"
                  min={0}
                  max={280}
                  step={10}
                  value={cfg.hopoThresholdMs}
                  onChange={(e) => update({hopoThresholdMs: Number(e.target.value)})}
                  className="mt-1.5 w-full accent-amber-500"
                />
              </div>

              <div>
                <div className="flex justify-between text-xs">
                  <label htmlFor="cfg-tap" className="font-medium text-slate-300">
                    Tap-Anteil
                  </label>
                  <span className="font-mono-tabular text-amber-400">
                    {Math.round(cfg.tapRate * 100)}%
                  </span>
                </div>
                <input
                  id="cfg-tap"
                  type="range"
                  min={0}
                  max={40}
                  step={1}
                  value={Math.round(cfg.tapRate * 100)}
                  onChange={(e) => update({tapRate: Number(e.target.value) / 100})}
                  className="mt-1.5 w-full accent-amber-500"
                />
              </div>
            </div>

            {activeMode === 'ghl' && (
              <div className="space-y-3 border-t border-[#263145] pt-4">
                <div className="text-xs font-semibold text-slate-200">
                  GHL 6-Bund Ergonomie-Regeln (Black & White Frets)
                </div>

                <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                  <label className="flex cursor-pointer items-center gap-2.5 rounded-lg border border-[#263145] bg-[#0B0F17]/60 px-3 py-2 text-xs text-slate-200">
                    <input
                      type="checkbox"
                      checked={cfg.allowWhiteFrets}
                      onChange={(e) => update({allowWhiteFrets: e.target.checked})}
                      className="h-4 w-4 accent-amber-500"
                    />
                    White Frets (W1–W3, untere Reihe)
                  </label>
                  <label className="flex cursor-pointer items-center gap-2.5 rounded-lg border border-[#263145] bg-[#0B0F17]/60 px-3 py-2 text-xs text-slate-200">
                    <input
                      type="checkbox"
                      checked={cfg.allowBlackFrets}
                      onChange={(e) => update({allowBlackFrets: e.target.checked})}
                      className="h-4 w-4 accent-amber-500"
                    />
                    Black Frets (B1–B3, obere Reihe)
                  </label>
                  <label className="flex cursor-pointer items-center gap-2.5 rounded-lg border border-[#263145] bg-[#0B0F17]/60 px-3 py-2 text-xs text-slate-200">
                    <input
                      type="checkbox"
                      checked={cfg.allowBarreChords}
                      onChange={(e) => update({allowBarreChords: e.target.checked})}
                      className="h-4 w-4 accent-amber-500"
                    />
                    Barre-Akkorde (B1+W1, B2+W2, B3+W3)
                  </label>
                  <label className="flex cursor-pointer items-center gap-2.5 rounded-lg border border-[#263145] bg-[#0B0F17]/60 px-3 py-2 text-xs text-slate-200">
                    <input
                      type="checkbox"
                      checked={cfg.allowDiagonalChords}
                      onChange={(e) => update({allowDiagonalChords: e.target.checked})}
                      className="h-4 w-4 accent-amber-500"
                    />
                    Diagonal-Akkorde (W1+B2, B1+W2, ...)
                  </label>
                </div>

                <div>
                  <div className="flex justify-between text-xs">
                    <label htmlFor="cfg-row-penalty" className="font-medium text-slate-300">
                      Reihenwechsel-Glättung (vermeidet hektische W/B-Sprünge)
                    </label>
                    <span className="font-mono-tabular text-amber-400">
                      {Math.round(cfg.rowSwitchPenalty * 100)}%
                    </span>
                  </div>
                  <input
                    id="cfg-row-penalty"
                    type="range"
                    min={0}
                    max={100}
                    step={5}
                    value={Math.round(cfg.rowSwitchPenalty * 100)}
                    onChange={(e) => update({rowSwitchPenalty: Number(e.target.value) / 100})}
                    className="mt-1.5 w-full accent-amber-500"
                  />
                </div>
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
};
