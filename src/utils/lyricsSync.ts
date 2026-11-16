import type {BpmMarker, LyricPhrase, LyricSyllable} from '../types/chart';
import {DEFAULT_RESOLUTION, tickToTimeSec, timeSecToTick} from './timing';

export interface ParsedLrcLine {
  timeSec: number;
  text: string;
}

const LRC_TIMESTAMP_RE = /\[(\d{1,3}):(\d{2})(?:\.(\d{1,3}))?\]/g;

export function parseLrcString(lrcText: string): ParsedLrcLine[] {
  const lines = lrcText.split(/\r?\n/);
  const parsed: ParsedLrcLine[] = [];

  for (const rawLine of lines) {
    const timestamps: number[] = [];
    let match: RegExpExecArray | null;
    LRC_TIMESTAMP_RE.lastIndex = 0;

    while ((match = LRC_TIMESTAMP_RE.exec(rawLine)) !== null) {
      const min = Number(match[1]);
      const sec = Number(match[2]);
      const fracStr = match[3] || '0';
      const frac = fracStr.length === 3 ? Number(fracStr) / 1000 : Number(fracStr) / 100;
      timestamps.push(min * 60 + sec + frac);
    }

    if (timestamps.length === 0) continue;

    const cleanText = rawLine.replace(LRC_TIMESTAMP_RE, '').trim();
    if (!cleanText) continue;

    for (const timeSec of timestamps) {
      parsed.push({timeSec, text: cleanText});
    }
  }

  return parsed.sort((a, b) => a.timeSec - b.timeSec);
}

/**
 * Splits a word into readable karaoke syllables if no manual hyphens are given.
 * Respects explicit "-" markers first.
 */
export function splitWordIntoSyllables(word: string): {text: string; hyphenated: boolean}[] {
  if (word.includes('-') && word.length > 2) {
    const parts = word.split('-').filter(Boolean);
    if (parts.length > 1) {
      return parts.map((part, idx) => ({
        text: part,
        hyphenated: idx < parts.length - 1,
      }));
    }
  }

  // Only split long words (> 7 alphanumeric chars) at natural vowel boundaries
  const cleanLen = word.replace(/[^a-zA-ZäöüÄÖÜß]/g, '').length;
  if (cleanLen < 8) {
    return [{text: word, hyphenated: false}];
  }

  const vowels = /[aeiouyäöüAEIOUYÄÖÜ]/;
  const syllables: string[] = [];
  let start = 0;

  for (let i = 2; i < word.length - 2; i++) {
    if (vowels.test(word[i]) && !vowels.test(word[i + 1]) && i - start >= 2) {
      const splitPoint = i + 1;
      if (word.length - splitPoint >= 3) {
        syllables.push(word.slice(start, splitPoint));
        start = splitPoint;
        i += 2;
      }
    }
  }
  syllables.push(word.slice(start));

  if (syllables.length <= 1) {
    return [{text: word, hyphenated: false}];
  }

  return syllables.map((part, idx) => ({
    text: part,
    hyphenated: idx < syllables.length - 1,
  }));
}

export function lrcLinesToPhrases(
  lines: ParsedLrcLine[],
  bpmMarkers: BpmMarker[],
  resolution: number = DEFAULT_RESOLUTION,
  offsetMs: number = 0,
  songDurationSec: number = 180
): LyricPhrase[] {
  if (lines.length === 0) return [];

  return lines.map((line, lineIdx) => {
    const nextLine = lines[lineIdx + 1];
    const startSec = line.timeSec;
    const defaultSpan = Math.min(4.2, Math.max(1.2, line.text.length * 0.085));
    const maxEndSec = nextLine ? Math.max(startSec + 0.35, nextLine.timeSec - 0.08) : Math.min(songDurationSec, startSec + defaultSpan);
    const endSec = Math.min(maxEndSec, startSec + Math.max(1.1, defaultSpan));

    const startTick = timeSecToTick(startSec, bpmMarkers, resolution, offsetMs);
    const endTick = Math.max(startTick + 48, timeSecToTick(endSec, bpmMarkers, resolution, offsetMs));

    const words = line.text.split(/\s+/).filter(Boolean);
    const expanded: {text: string; hyphenated: boolean}[] = [];
    for (const w of words) {
      expanded.push(...splitWordIntoSyllables(w));
    }

    const totalChars = expanded.reduce((acc, s) => acc + Math.max(1, s.text.length), 0) || 1;
    const totalTicks = Math.max(24, endTick - startTick);

    let cursorTick = startTick;
    const syllables: LyricSyllable[] = expanded.map((item, sIdx) => {
      const tick = cursorTick;
      const weight = Math.max(1, item.text.length) / totalChars;
      const advance = Math.max(12, Math.round(totalTicks * weight));
      cursorTick = Math.min(endTick - 12, cursorTick + advance);
      return {
        id: `syl-${lineIdx}-${sIdx}-${tick}`,
        tick,
        text: item.text,
        hyphenated: item.hyphenated,
      };
    });

    return {
      id: `phrase-${lineIdx}-${startTick}`,
      startTick,
      endTick,
      syllables,
    };
  });
}

export function plainTextToTimedPhrases(
  plainText: string,
  songDurationSec: number,
  bpmMarkers: BpmMarker[],
  resolution: number = DEFAULT_RESOLUTION,
  offsetMs: number = 0
): LyricPhrase[] {
  const rawLines = plainText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  if (rawLines.length === 0) return [];

  const introSec = Math.min(4.0, songDurationSec * 0.12);
  const outroSec = Math.max(introSec + 2, songDurationSec - Math.min(3.0, songDurationSec * 0.08));
  const usableSec = Math.max(4, outroSec - introSec);
  const stepSec = usableSec / rawLines.length;

  const lrcLines: ParsedLrcLine[] = rawLines.map((text, idx) => ({
    timeSec: introSec + idx * stepSec,
    text,
  }));

  return lrcLinesToPhrases(lrcLines, bpmMarkers, resolution, offsetMs, songDurationSec);
}

export function getActiveLyricDisplay(
  phrases: LyricPhrase[],
  currentTimeSec: number,
  bpmMarkers: BpmMarker[],
  resolution: number = DEFAULT_RESOLUTION,
  offsetMs: number = 0
): {phrase: LyricPhrase | null; activeSyllableIndex: number} {
  if (phrases.length === 0) return {phrase: null, activeSyllableIndex: -1};
  const currentTick = timeSecToTick(currentTimeSec, bpmMarkers, resolution, offsetMs);

  for (let i = 0; i < phrases.length; i++) {
    const phrase = phrases[i];
    const nextPhrase = phrases[i + 1];
    const windowEnd = nextPhrase ? Math.min(phrase.endTick + 96, nextPhrase.startTick - 1) : phrase.endTick + 192;

    if (currentTick >= phrase.startTick - 48 && currentTick <= windowEnd) {
      let activeIdx = -1;
      for (let s = 0; s < phrase.syllables.length; s++) {
        if (currentTick >= phrase.syllables[s].tick) {
          activeIdx = s;
        }
      }
      return {phrase, activeSyllableIndex: activeIdx};
    }
  }

  return {phrase: null, activeSyllableIndex: -1};
}

export function formatPhraseText(phrase: LyricPhrase): string {
  return phrase.syllables
    .map((s, idx) => {
      if (s.hyphenated) return `${s.text}-`;
      return idx < phrase.syllables.length - 1 ? `${s.text} ` : s.text;
    })
    .join('')
    .trim();
}

export function shiftPhraseTicks(phrase: LyricPhrase, deltaTicks: number): LyricPhrase {
  const safeDelta = phrase.startTick + deltaTicks < 0 ? -phrase.startTick : deltaTicks;
  return {
    ...phrase,
    startTick: phrase.startTick + safeDelta,
    endTick: phrase.endTick + safeDelta,
    syllables: phrase.syllables.map((s) => ({
      ...s,
      tick: Math.max(0, s.tick + safeDelta),
    })),
  };
}

export function tapSyncPhraseToTime(
  phrase: LyricPhrase,
  targetTimeSec: number,
  bpmMarkers: BpmMarker[],
  resolution: number = DEFAULT_RESOLUTION,
  offsetMs: number = 0
): LyricPhrase {
  const newStart = timeSecToTick(targetTimeSec, bpmMarkers, resolution, offsetMs);
  const delta = newStart - phrase.startTick;
  return shiftPhraseTicks(phrase, delta);
}

export function formatPhraseTimestamp(
  phrase: LyricPhrase,
  bpmMarkers: BpmMarker[],
  resolution: number = DEFAULT_RESOLUTION,
  offsetMs: number = 0
): number {
  return tickToTimeSec(phrase.startTick, bpmMarkers, resolution, offsetMs);
}
