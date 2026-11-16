import type {
  AnyFretId,
  BpmMarker,
  ChartNote,
  ChartTracks,
  DetectedOnset,
  Difficulty,
  DifficultyConfig,
  DifficultyConfigMap,
  FiveFretId,
  GhlFretId,
  InstrumentTrack,
  StarPowerPhrase,
} from '../types/chart';
import {DIFFICULTIES} from './difficultyPresets';
import {DEFAULT_RESOLUTION, getGridStepTicks, quantizeTick, timeSecToTick} from './timing';

const FIVE_FRETS: FiveFretId[] = ['G', 'R', 'Y', 'B', 'O'];
const GHL_WHITE_FRETS: GhlFretId[] = ['W1', 'W2', 'W3'];
const GHL_BLACK_FRETS: GhlFretId[] = ['B1', 'B2', 'B3'];

interface SelectedEvent {
  tick: number;
  onset: DetectedOnset;
}

type PassageKind = 'fast_run' | 'short_staccato' | 'sustained_hold' | 'groove_accent';

interface RiffMatchRef {
  templateStart: number;
  offset: number;
}

function selectAndQuantizeOnsets(
  onsets: DetectedOnset[],
  config: DifficultyConfig,
  bpmMarkers: BpmMarker[],
  offsetMs: number,
  durationSec: number,
  resolution: number
): SelectedEvent[] {
  const minStrength = Math.max(0.08, 1 - config.onsetSensitivity);
  const minSpacingSec = config.minSpacingMs / 1000;
  const maxTick = Math.max(
    resolution * 4,
    timeSecToTick(durationSec - 0.12, bpmMarkers, resolution, offsetMs)
  );
  const step = getGridStepTicks(resolution, config.quantizeGrid);
  const subStep = Math.max(24, Math.floor(step / 2));

  const chosen: SelectedEvent[] = [];
  let lastTimeSec = -minSpacingSec;
  let prevTimeGapSec = 1.0;
  let lastTick = -1;

  for (let i = 0; i < onsets.length; i++) {
    const onset = onsets[i];
    const dtSec = onset.timeSec - lastTimeSec;
    if (dtSec < minSpacingSec) continue;

    const rawTick = timeSecToTick(onset.timeSec, bpmMarkers, resolution, offsetMs);
    let qTick = quantizeTick(rawTick, resolution, config.quantizeGrid);
    if (qTick > maxTick) continue;

    // Beat-grid salience weighting: reward hits locked to quarter/eighth beats, filter weak off-grid stray transients
    const distToGrid = Math.abs(rawTick - qTick);
    const onBeat = qTick % resolution === 0;
    const onEighth = qTick % (resolution / 2) === 0;
    const gridBoost = onBeat ? 0.10 : onEighth ? 0.05 : 0;
    if (onset.strength + gridBoost < minStrength) continue;
    if (!onEighth && distToGrid > step * 0.36 && onset.strength < minStrength + 0.13) {
      continue;
    }

    // Handle grid collision: ONLY split into 1/32nd subStep inside genuine fast melodic/tremolo bursts,
    // never from a trailing same-pitch attack bloom ("keine doppelten Off-Beat-Noten")
    if (qTick <= lastTick) {
      const prevEvent = chosen[chosen.length - 1];
      const inSustainedBurst = prevTimeGapSec <= 0.15 && dtSec <= 0.135;
      const strongPitchShift =
        prevEvent !== undefined &&
        Math.abs(onset.centroid - prevEvent.onset.centroid) >= 0.035 &&
        onset.strength >= Math.max(minStrength + 0.08, 0.42);
      const allowBurstSubStep =
        config.quantizeGrid >= 16 &&
        config.onsetSensitivity >= 0.65 &&
        dtSec <= 0.135 &&
        (inSustainedBurst || strongPitchShift);

      if (allowBurstSubStep) {
        const fineTick = lastTick + subStep;
        if (fineTick <= maxTick && Math.abs(rawTick - fineTick) <= subStep * 0.9) {
          qTick = fineTick;
        }
      } else if (
        prevEvent &&
        qTick === lastTick &&
        onset.strength > prevEvent.onset.strength + 0.14
      ) {
        // Keep the stronger transient at this grid slot without duplicating the note
        chosen[chosen.length - 1] = {tick: qTick, onset};
        lastTimeSec = onset.timeSec;
        continue;
      }
    }

    if (qTick <= lastTick) continue;

    chosen.push({tick: qTick, onset});
    prevTimeGapSec = dtSec;
    lastTimeSec = onset.timeSec;
    lastTick = qTick;
  }

  return chosen;
}

/**
 * Classifies each event into its local rhythmic/articulation passage context:
 * - fast_run: dense short notes (runs, shreds, tremolos) -> no sustains, clean playable shapes
 * - short_staccato: crisp hits followed by decay/rest -> no sustains
 * - sustained_hold: genuine held note with clean space before the next event
 * - groove_accent: medium-paced accented groove hits (ideal for chords & alternating rhythms)
 */
function classifyPassages(events: SelectedEvent[], resolution: number): PassageKind[] {
  const n = events.length;
  const kinds: PassageKind[] = new Array(n).fill('groove_accent');

  for (let i = 0; i < n; i++) {
    const cur = events[i];
    const prev = i > 0 ? events[i - 1] : null;
    const next = i + 1 < n ? events[i + 1] : null;

    const dtPrevSec = prev ? cur.onset.timeSec - prev.onset.timeSec : 1.0;
    const dtNextSec = next ? next.onset.timeSec - cur.onset.timeSec : 1.5;
    const dtPrevTicks = prev ? cur.tick - prev.tick : resolution * 2;
    const dtNextTicks = next ? next.tick - cur.tick : resolution * 2;

    // Local 3-step IOI check for rapid passages
    const inFastPair = dtPrevSec <= 0.185 && dtNextSec <= 0.21;
    const inFastTickRun =
      dtNextTicks <= Math.round(resolution * 0.55) ||
      (dtPrevTicks <= Math.round(resolution * 0.55) && dtNextTicks <= Math.round(resolution * 0.85));

    if (inFastPair || inFastTickRun) {
      kinds[i] = 'fast_run';
      continue;
    }

    // Short / staccato hit without genuine tonal hold
    if (cur.onset.sustainSec < 0.24 || dtNextTicks < Math.round(resolution * 0.85)) {
      kinds[i] = 'short_staccato';
      continue;
    }

    // Genuine held note with sufficient room before the next event
    if (cur.onset.sustainSec >= 0.28 && dtNextSec >= 0.36 && dtNextTicks >= resolution) {
      kinds[i] = 'sustained_hold';
      continue;
    }

    kinds[i] = 'groove_accent';
  }

  return kinds;
}

/**
 * Detects repeating musical riff motifs (lengths 8, 6, 4) across the track using quantized
 * rhythm intervals + relative spectral contour + heavy-bass pedal signatures.
 * Matched repetitions replay the same musical fret pattern instead of drifting randomly.
 */
function detectRiffMotifs(events: SelectedEvent[]): Map<number, RiffMatchRef> {
  const matches = new Map<number, RiffMatchRef>();
  const n = events.length;
  if (n < 8) return matches;

  // Build per-event quantized contour & rhythm signature
  const rhythmBucket: number[] = new Array(n).fill(4);
  const contourTier: number[] = new Array(n).fill(1); // 0=low, 1=mid, 2=high
  const isPedalBass: boolean[] = new Array(n).fill(false);

  for (let i = 0; i < n; i++) {
    const dtTicks = i + 1 < n ? events[i + 1].tick - events[i].tick : 192;
    rhythmBucket[i] = Math.min(12, Math.max(1, Math.round(dtTicks / 32)));

    // Local centroid mean in +-3 window to keep riff shape invariant to mix brightness shifts
    let sumC = 0;
    let cnt = 0;
    for (let k = Math.max(0, i - 3); k <= Math.min(n - 1, i + 3); k++) {
      sumC += events[k].onset.centroid;
      cnt++;
    }
    const localMean = sumC / Math.max(1, cnt);
    const delta = events[i].onset.centroid - localMean;
    contourTier[i] = delta < -0.055 ? 0 : delta > 0.055 ? 2 : 1;
    isPedalBass[i] = events[i].onset.lowEnergy > 0.68 && events[i].onset.centroid < 0.38;
  }

  const assigned = new Uint8Array(n); // avoid overlapping motif assignments

  for (const len of [8, 6, 4]) {
    if (n < len * 2) continue;
    for (let tStart = 0; tStart <= n - len * 2; tStart++) {
      if (assigned[tStart]) continue;

      for (let cStart = tStart + len; cStart <= Math.min(n - len, tStart + len * 8); cStart++) {
        let alreadyTaken = false;
        for (let k = 0; k < len; k++) {
          if (assigned[cStart + k]) {
            alreadyTaken = true;
            break;
          }
        }
        if (alreadyTaken) continue;

        let rhythmHits = 0;
        let contourHits = 0;
        for (let k = 0; k < len; k++) {
          const rDiff = Math.abs(rhythmBucket[tStart + k] - rhythmBucket[cStart + k]);
          if (rDiff <= 1 || k === len - 1) rhythmHits++;
          if (
            contourTier[tStart + k] === contourTier[cStart + k] &&
            isPedalBass[tStart + k] === isPedalBass[cStart + k]
          ) {
            contourHits++;
          }
        }

        if (rhythmHits >= Math.ceil(len * 0.85) && contourHits >= Math.ceil(len * 0.75)) {
          for (let k = 0; k < len; k++) {
            assigned[cStart + k] = 1;
            matches.set(cStart + k, {templateStart: tStart, offset: k});
          }
        }
      }
    }
  }

  return matches;
}

function generateStarPowerFromEvents(
  events: SelectedEvent[],
  density: number,
  durationSec: number,
  bpmMarkers: BpmMarker[],
  offsetMs: number,
  resolution: number
): StarPowerPhrase[] {
  if (events.length < 8 || density <= 0.05) return [];

  const targetCount = Math.max(1, Math.min(8, Math.round((durationSec / 22) * (0.6 + density * 1.4))));
  const spanEvents = Math.max(4, Math.floor(events.length / (targetCount + 1)));
  const phrases: StarPowerPhrase[] = [];

  for (let i = 0; i < targetCount; i++) {
    const startIdx = Math.min(events.length - 4, Math.floor((i + 0.5) * spanEvents));
    const endIdx = Math.min(events.length - 1, startIdx + Math.max(3, Math.round(4 + density * 4)));
    const startTick = events[startIdx].tick;
    const endTick = Math.max(startTick + resolution * 2, events[endIdx].tick + 48);

    const prev = phrases[phrases.length - 1];
    if (prev && startTick <= prev.tick + prev.duration + resolution * 2) continue;

    phrases.push({
      id: `sp-${startTick}`,
      tick: startTick,
      duration: endTick - startTick,
    });
  }

  const maxTick = timeSecToTick(durationSec, bpmMarkers, resolution, offsetMs);
  return phrases.filter((p) => p.tick < maxTick);
}

/**
 * Computes sustain duration in ticks ONLY for genuinely sustained passages,
 * strictly respecting release gaps before the next note and extra breathing room before
 * another sustained note ("keine lange note in eine lange note setzten").
 */
function computeSmartSustainTicks(
  idx: number,
  events: SelectedEvent[],
  passages: PassageKind[],
  config: DifficultyConfig,
  bpmMarkers: BpmMarker[],
  offsetMs: number,
  resolution: number
): number {
  if (config.sustainSensitivity <= 0.05) return 0;

  // Short staccato notes and rapid runs NEVER receive sustain tails
  if (passages[idx] === 'fast_run' || passages[idx] === 'short_staccato') {
    return 0;
  }

  const cur = events[idx];
  const minSustainThreshold = 0.62 - config.sustainSensitivity * 0.36; // ~0.26s..0.62s
  if (cur.onset.sustainSec < minSustainThreshold) return 0;

  const endSec =
    cur.onset.timeSec + cur.onset.sustainSec * (0.62 + config.sustainSensitivity * 0.42);
  const rawEndTick = timeSecToTick(endSec, bpmMarkers, resolution, offsetMs);
  const qEndTick = quantizeTick(rawEndTick, resolution, config.quantizeGrid);
  const step = getGridStepTicks(resolution, config.quantizeGrid);

  const nextEvent = events[idx + 1];
  const nextIsSustained = idx + 1 < events.length && passages[idx + 1] === 'sustained_hold';

  // Enforce at least 1/16 rest before a short note, and 3/32..1/8 rest before another long note
  const releaseGapTicks = nextIsSustained
    ? Math.max(Math.round(resolution * 0.375), step) // >= 72 ticks before another long note
    : Math.max(Math.round(resolution * 0.25), Math.floor(step * 0.75)); // >= 48 ticks before short note

  const maxAllowedEnd = nextEvent ? nextEvent.tick - releaseGapTicks : qEndTick;
  const sustain = Math.min(qEndTick, maxAllowedEnd) - cur.tick;

  // Avoid meaningless micro-tails; require at least half a beat (96 ticks)
  const minValidSustain = Math.round(resolution * 0.5);
  return sustain >= minValidSustain ? sustain : 0;
}

/**
 * Final hard invariant pass over any generated or edited note array:
 * Guarantees that no note's sustain tail touches, overlaps, or enters the next note
 * (and enforces a wider release gap whenever the following note is also sustained).
 */
export function enforceNonOverlappingSustains(
  notes: ChartNote[],
  resolution: number = DEFAULT_RESOLUTION
): ChartNote[] {
  if (notes.length === 0) return notes;

  const sorted = [...notes].sort((a, b) => a.tick - b.tick);
  const tickGroups: {tick: number; items: ChartNote[]}[] = [];

  for (const note of sorted) {
    const last = tickGroups[tickGroups.length - 1];
    if (last && last.tick === note.tick) {
      last.items.push({...note});
    } else {
      tickGroups.push({tick: note.tick, items: [{...note}]});
    }
  }

  const minValidSustain = Math.round(resolution * 0.45);
  const shortGapTicks = Math.round(resolution * 0.25); // 48 ticks (1/16th rest)
  const longToLongGapTicks = Math.round(resolution * 0.375); // 72 ticks before next sustain

  for (let i = 0; i < tickGroups.length - 1; i++) {
    const curGroup = tickGroups[i];
    const nextGroup = tickGroups[i + 1];
    const deltaTicks = nextGroup.tick - curGroup.tick;
    const nextHasSustain = nextGroup.items.some((n) => n.sustain > 0);
    const requiredGap = nextHasSustain ? longToLongGapTicks : shortGapTicks;
    const maxSustain = Math.max(0, deltaTicks - requiredGap);

    for (const item of curGroup.items) {
      if (item.sustain <= 0) continue;
      const clamped = Math.min(item.sustain, maxSustain);
      item.sustain = clamped >= minValidSustain ? clamped : 0;
    }
  }

  return tickGroups.flatMap((g) => g.items);
}

/**
 * Generates an ergonomic, musical 5-Fret Guitar track for a given difficulty.
 */
export function generateFiveFretTrack(
  onsets: DetectedOnset[],
  config: DifficultyConfig,
  bpmMarkers: BpmMarker[],
  offsetMs: number,
  durationSec: number,
  resolution: number = DEFAULT_RESOLUTION
): InstrumentTrack {
  const events = selectAndQuantizeOnsets(
    onsets,
    config,
    bpmMarkers,
    offsetMs,
    durationSec,
    resolution
  );
  const passages = classifyPassages(events, resolution);
  const riffMatches = detectRiffMotifs(events);

  const rawNotes: ChartNote[] = [];
  const chosenPattern: {lane: number; isOpen: boolean; isChord: boolean}[] = new Array(events.length);

  // Easy uses 3 frets (G,R,Y), Medium uses 4 (G,R,Y,B), Hard/Expert use all 5
  const maxLaneIndex =
    config.maxChordSize === 1 && config.chordProbability === 0 && config.hopoThresholdMs === 0
      ? 2 // Easy: G, R, Y
      : config.tapRate === 0 && config.maxChordSize <= 2 && config.quantizeGrid <= 8
        ? 3 // Medium: G, R, Y, B
        : 4; // Hard/Expert: G, R, Y, B, O

  let prevLane = 1;
  let prevTimeSec = -10;
  let prevWasChord = false;
  let prevCentroid = 0.5;

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    const {tick, onset} = ev;
    const passage = passages[i];
    const sustain = computeSmartSustainTicks(
      i,
      events,
      passages,
      config,
      bpmMarkers,
      offsetMs,
      resolution
    );

    const riffRef = riffMatches.get(i);
    const matchedTemplate =
      riffRef !== undefined ? chosenPattern[riffRef.templateStart + riffRef.offset] : undefined;

    // Open note check on heavy low-end bass/kick transients (or replayed from recognized pedal riff)
    const isHeavyBass = onset.lowEnergy > 0.7 && onset.centroid < 0.37;
    const isPedalAlternation =
      isHeavyBass &&
      i + 1 < events.length &&
      events[i + 1].onset.centroid > onset.centroid + 0.14;
    const useOpen = matchedTemplate
      ? matchedTemplate.isOpen
      : config.openNoteRate > 0 &&
        isHeavyBass &&
        (isPedalAlternation || i % Math.max(2, Math.round(1 / config.openNoteRate)) === 0);

    if (useOpen) {
      chosenPattern[i] = {lane: prevLane, isOpen: true, isChord: false};
      rawNotes.push({
        id: `5f-${tick}-OPEN`,
        tick,
        fret: 'OPEN',
        sustain,
        forced: false,
        tap: false,
      });
      prevTimeSec = onset.timeSec;
      prevWasChord = false;
      prevCentroid = onset.centroid;
      continue;
    }

    const dtMs = (onset.timeSec - prevTimeSec) * 1000;
    let lane = prevLane;

    if (matchedTemplate) {
      // Replay recognized riff's exact fret shape
      lane = Math.min(maxLaneIndex, Math.max(0, matchedTemplate.lane));
    } else if (
      passage === 'fast_run' &&
      Math.abs(onset.centroid - prevCentroid) < 0.06 &&
      dtMs < 170
    ) {
      // Same-pitch fast tremolo picking stays anchored on one fret instead of wobbling
      lane = prevLane;
    } else {
      const targetLane = Math.min(maxLaneIndex, Math.max(0, Math.round(onset.centroid * maxLaneIndex)));
      if (targetLane > prevLane) {
        const stepJump = passage === 'fast_run' ? 1 : targetLane - prevLane > 2 ? 2 : 1;
        lane = Math.min(maxLaneIndex, prevLane + stepJump);
      } else if (targetLane < prevLane) {
        const stepJump = passage === 'fast_run' ? 1 : prevLane - targetLane > 2 ? 2 : 1;
        lane = Math.max(0, prevLane - stepJump);
      } else if (passage === 'fast_run' && Math.abs(onset.centroid - prevCentroid) >= 0.08) {
        // Inside fast melodic runs, prefer audible staircase motion if centroid clearly shifted
        if (onset.centroid > prevCentroid && prevLane < maxLaneIndex) lane = prevLane + 1;
        else if (onset.centroid < prevCentroid && prevLane > 0) lane = prevLane - 1;
      }
    }

    // Keep fast runs single-note playable; allow chords in accented grooves & held hits
    const wantChord = matchedTemplate
      ? matchedTemplate.isChord && config.maxChordSize > 1
      : passage !== 'fast_run' &&
        config.maxChordSize > 1 &&
        config.chordProbability > 0 &&
        onset.strength > 0.68 - config.chordProbability * 0.45 &&
        !prevWasChord;

    const lanesForTick: FiveFretId[] = [FIVE_FRETS[lane]];

    if (wantChord) {
      const partnerOffset =
        lane + 2 <= maxLaneIndex
          ? 2
          : lane - 2 >= 0
            ? -2
            : lane + 1 <= maxLaneIndex
              ? 1
              : -1;
      const partnerLane = Math.min(maxLaneIndex, Math.max(0, lane + partnerOffset));
      if (partnerLane !== lane) {
        lanesForTick.push(FIVE_FRETS[partnerLane]);
      }
      if (config.maxChordSize >= 3 && onset.strength > 0.85 && maxLaneIndex >= 4) {
        const thirdLane = Math.min(maxLaneIndex, Math.max(0, Math.round((lane + partnerLane) / 2)));
        if (thirdLane !== lane && thirdLane !== partnerLane) {
          lanesForTick.push(FIVE_FRETS[thirdLane]);
        }
      }
    }

    const isChord = lanesForTick.length > 1;
    chosenPattern[i] = {lane, isOpen: false, isChord};

    const isHopoCandidate =
      !isChord && !prevWasChord && lane !== prevLane && dtMs <= config.hopoThresholdMs;
    const isTap =
      isHopoCandidate &&
      config.tapRate > 0 &&
      (passage === 'fast_run' || onset.highEnergy > 0.65) &&
      i % Math.max(2, Math.round(1 / config.tapRate)) === 0;

    for (const fret of lanesForTick) {
      rawNotes.push({
        id: `5f-${tick}-${fret}`,
        tick,
        fret,
        sustain,
        forced: isHopoCandidate && !isTap && dtMs > 105,
        tap: isTap,
      });
    }

    prevLane = lane;
    prevTimeSec = onset.timeSec;
    prevWasChord = isChord;
    prevCentroid = onset.centroid;
  }

  const notes = enforceNonOverlappingSustains(rawNotes, resolution);
  const starPower = generateStarPowerFromEvents(
    events,
    config.starPowerDensity,
    durationSec,
    bpmMarkers,
    offsetMs,
    resolution
  );

  return {notes, starPower};
}

/**
 * Generates a full-featured, ergonomic 6-Fret Guitar Hero Live (GHL) track.
 * Models the 3-column × 2-row fret board (White 1-3 bottom row, Black 1-3 top row, plus Open).
 * Builds authentic GHL barre chords (B+W same column) and diagonal power chords while preventing
 * impossible split-row hand stretches, preserving fast short runs, recognizing riffs, and
 * preventing overlapping sustain tails.
 */
export function generateGhlTrack(
  onsets: DetectedOnset[],
  config: DifficultyConfig,
  bpmMarkers: BpmMarker[],
  offsetMs: number,
  durationSec: number,
  resolution: number = DEFAULT_RESOLUTION
): InstrumentTrack {
  const events = selectAndQuantizeOnsets(
    onsets,
    config,
    bpmMarkers,
    offsetMs,
    durationSec,
    resolution
  );
  const passages = classifyPassages(events, resolution);
  const riffMatches = detectRiffMotifs(events);

  const rawNotes: ChartNote[] = [];
  const chosenPattern: {col: number; row: 'W' | 'B'; isOpen: boolean; isChord: boolean}[] =
    new Array(events.length);

  let prevCol = 0; // 0, 1, 2
  let prevRow: 'W' | 'B' = 'W';
  let prevTimeSec = -10;
  let prevWasChord = false;
  let prevCentroid = 0.5;

  const canUseWhite = config.allowWhiteFrets || !config.allowBlackFrets;
  const canUseBlack = config.allowBlackFrets;

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    const {tick, onset} = ev;
    const passage = passages[i];
    const sustain = computeSmartSustainTicks(
      i,
      events,
      passages,
      config,
      bpmMarkers,
      offsetMs,
      resolution
    );

    const riffRef = riffMatches.get(i);
    const matchedTemplate =
      riffRef !== undefined ? chosenPattern[riffRef.templateStart + riffRef.offset] : undefined;

    // GHL Open Strum on heavy low-end hits or pedal-tone chug riffs
    const isHeavyBass = onset.lowEnergy > 0.7 && onset.centroid < 0.38;
    const isPedalAlternation =
      isHeavyBass &&
      i + 1 < events.length &&
      events[i + 1].onset.centroid > onset.centroid + 0.14;
    const useOpen = matchedTemplate
      ? matchedTemplate.isOpen
      : config.openNoteRate > 0 &&
        isHeavyBass &&
        (isPedalAlternation || i % Math.max(2, Math.round(1 / config.openNoteRate)) === 0);

    if (useOpen) {
      chosenPattern[i] = {col: prevCol, row: prevRow, isOpen: true, isChord: false};
      rawNotes.push({
        id: `ghl-${tick}-OPEN`,
        tick,
        fret: 'OPEN',
        sustain,
        forced: false,
        tap: false,
      });
      prevTimeSec = onset.timeSec;
      prevWasChord = false;
      prevCentroid = onset.centroid;
      continue;
    }

    const dtMs = (onset.timeSec - prevTimeSec) * 1000;
    let col = prevCol;
    let row: 'W' | 'B' = prevRow;

    if (matchedTemplate) {
      // Replay exact recognized riff shape while respecting Black/White preset toggles
      col = Math.min(2, Math.max(0, matchedTemplate.col));
      row =
        matchedTemplate.row === 'B'
          ? canUseBlack
            ? 'B'
            : 'W'
          : canUseWhite
            ? 'W'
            : 'B';
    } else if (
      passage === 'fast_run' &&
      Math.abs(onset.centroid - prevCentroid) < 0.06 &&
      dtMs < 170
    ) {
      // Same-pitch fast tremolo picking stays anchored on one GHL fret
      col = prevCol;
      row = prevRow;
    } else {
      const targetCol = Math.min(2, Math.max(0, Math.round(onset.centroid * 2)));
      if (targetCol > prevCol) col = Math.min(2, prevCol + 1);
      else if (targetCol < prevCol) col = Math.max(0, prevCol - 1);

      if (canUseWhite && canUseBlack) {
        const wantBlack =
          onset.highEnergy + onset.centroid * 0.38 > 0.50 + config.rowSwitchPenalty * 0.25;
        const desiredRow: 'W' | 'B' = wantBlack ? 'B' : 'W';
        if (desiredRow !== prevRow) {
          const dtSec = onset.timeSec - prevTimeSec;
          const strongRegisterShift = Math.abs(onset.centroid - prevCentroid) >= 0.14;
          if (
            dtSec >= 0.11 + config.rowSwitchPenalty * 0.34 ||
            (strongRegisterShift && dtSec >= 0.10) ||
            onset.strength > 0.78
          ) {
            row = desiredRow;
          }
        }
      } else {
        row = canUseBlack ? 'B' : 'W';
      }
    }

    const primaryFret: GhlFretId = row === 'B' ? GHL_BLACK_FRETS[col] : GHL_WHITE_FRETS[col];
    const fretsForTick: GhlFretId[] = [primaryFret];

    const wantChord = matchedTemplate
      ? matchedTemplate.isChord && config.maxChordSize > 1
      : passage !== 'fast_run' &&
        config.maxChordSize > 1 &&
        config.chordProbability > 0 &&
        onset.strength > 0.66 - config.chordProbability * 0.45 &&
        !prevWasChord;

    if (wantChord) {
      if (
        config.allowBarreChords &&
        canUseWhite &&
        canUseBlack &&
        (onset.lowEnergy > 0.52 || !config.allowDiagonalChords)
      ) {
        const barrePartner = row === 'B' ? GHL_WHITE_FRETS[col] : GHL_BLACK_FRETS[col];
        fretsForTick.push(barrePartner);
      } else if (config.allowDiagonalChords && canUseWhite && canUseBlack) {
        const nextCol = col < 2 ? col + 1 : col - 1;
        const oppRow = row === 'B' ? GHL_WHITE_FRETS : GHL_BLACK_FRETS;
        fretsForTick.push(oppRow[nextCol]);
      } else {
        const adjCol = col < 2 ? col + 1 : col - 1;
        const sameRow = row === 'B' ? GHL_BLACK_FRETS : GHL_WHITE_FRETS;
        fretsForTick.push(sameRow[adjCol]);
      }

      if (config.maxChordSize >= 3 && onset.strength > 0.84 && canUseWhite && canUseBlack) {
        const adjCol = col < 2 ? col + 1 : col - 1;
        const extra = row === 'B' ? GHL_BLACK_FRETS[adjCol] : GHL_WHITE_FRETS[adjCol];
        if (!fretsForTick.includes(extra)) {
          fretsForTick.push(extra);
        }
      }
    }

    const isChord = fretsForTick.length > 1;
    chosenPattern[i] = {col, row, isOpen: false, isChord};

    const changedFret = col !== prevCol || row !== prevRow;
    const isHopoCandidate =
      !isChord && !prevWasChord && changedFret && dtMs <= config.hopoThresholdMs;
    const isTap =
      isHopoCandidate &&
      config.tapRate > 0 &&
      (passage === 'fast_run' || onset.highEnergy > 0.62) &&
      i % Math.max(2, Math.round(1 / config.tapRate)) === 0;

    for (const fret of fretsForTick) {
      rawNotes.push({
        id: `ghl-${tick}-${fret}`,
        tick,
        fret,
        sustain,
        forced: isHopoCandidate && !isTap && dtMs > 105,
        tap: isTap,
      });
    }

    prevCol = col;
    prevRow = row;
    prevTimeSec = onset.timeSec;
    prevWasChord = isChord;
    prevCentroid = onset.centroid;
  }

  const notes = enforceNonOverlappingSustains(rawNotes, resolution);
  const starPower = generateStarPowerFromEvents(
    events,
    config.starPowerDensity,
    durationSec,
    bpmMarkers,
    offsetMs,
    resolution
  );

  return {notes, starPower};
}

export function generateAllCharts(
  onsets: DetectedOnset[],
  configs: DifficultyConfigMap,
  bpmMarkers: BpmMarker[],
  offsetMs: number,
  durationSec: number,
  resolution: number = DEFAULT_RESOLUTION
): ChartTracks {
  const fiveFret = {} as Record<Difficulty, InstrumentTrack>;
  const ghl = {} as Record<Difficulty, InstrumentTrack>;

  for (const diff of DIFFICULTIES) {
    fiveFret[diff] = generateFiveFretTrack(
      onsets,
      configs.fiveFret[diff],
      bpmMarkers,
      offsetMs,
      durationSec,
      resolution
    );
    ghl[diff] = generateGhlTrack(
      onsets,
      configs.ghl[diff],
      bpmMarkers,
      offsetMs,
      durationSec,
      resolution
    );
  }

  return {fiveFret, ghl};
}

/**
 * Computes Clone Hero song.ini difficulty rating (0..6) based on Expert note density.
 */
export function estimateDifficultyTier(notes: ChartNote[], durationSec: number): number {
  if (notes.length === 0 || durationSec <= 0) return 0;
  const uniqueTicks = new Set(notes.map((n) => n.tick)).size;
  const nps = uniqueTicks / durationSec;
  if (nps < 1.2) return 0;
  if (nps < 2.2) return 1;
  if (nps < 3.4) return 2;
  if (nps < 4.8) return 3;
  if (nps < 6.5) return 4;
  if (nps < 8.5) return 5;
  return 6;
}

export function getUniqueNoteCount(notes: ChartNote[]): number {
  return new Set(notes.map((n) => n.tick)).size;
}

export function sanitizeFretForMode(fret: AnyFretId, mode: '5fret' | 'ghl'): AnyFretId {
  if (mode === '5fret') {
    return ['G', 'R', 'Y', 'B', 'O', 'OPEN'].includes(fret) ? fret : 'G';
  }
  return ['W1', 'W2', 'W3', 'B1', 'B2', 'B3', 'OPEN'].includes(fret) ? fret : 'W1';
}
