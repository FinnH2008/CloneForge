import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractBestMusicGenre,
  pickBestLyricsResult,
  scoreMusicBrainzRecording,
  scoreMusicBrainzRelease,
} from './autoSelect';
import {analyzeAudioSamples, generateDemoAudioSamples, recomputeOffsetMsForBpm} from './audioDsp';
import {computeAudioFingerprint, extractEmbeddedMediaTags} from './audioId';
import {
  enforceNonOverlappingSustains,
  generateAllCharts,
  generateFiveFretTrack,
  generateGhlTrack,
  getUniqueNoteCount,
} from './chartGenerator';
import {GHL_FRET_TO_CHART_LANE, serializeChartFile, serializeSongIni} from './chartSerializer';
import {createDefaultDifficultyConfigs, DIFFICULTIES} from './difficultyPresets';
import {lrcLinesToPhrases, parseLrcString} from './lyricsSync';
import {
  cleanMediaTitle,
  DEFAULT_RESOLUTION,
  parseFilenameMetadata,
  quantizeTick,
  sanitizeArtistForQuery,
  tickToTimeSec,
  timeSecToTick,
} from './timing';

test('timing conversions round-trip with offset and variable BPM markers', () => {
  const bpmMarkers = [
    {tick: 0, bpm: 120},
    {tick: 768, bpm: 150}, // after 4 beats (2.0s at 120 BPM)
  ];
  const tick1 = timeSecToTick(1.0, bpmMarkers, DEFAULT_RESOLUTION, 0);
  assert.equal(tick1, 384);

  const sec1 = tickToTimeSec(384, bpmMarkers, DEFAULT_RESOLUTION, 0);
  assert.ok(Math.abs(sec1 - 1.0) < 0.005);

  // At tick 768 + 192 (1 beat into 150 BPM = 2.0s + 0.4s = 2.4s) + 100ms offset = 2.5s
  const sec2 = tickToTimeSec(768 + 192, bpmMarkers, DEFAULT_RESOLUTION, 100);
  assert.ok(Math.abs(sec2 - 2.5) < 0.01);

  assert.equal(quantizeTick(100, 192, 16), 96);
  assert.equal(quantizeTick(180, 192, 4), 192);
});

test('DSP onset & BPM detector analyzes demo audio accurately', () => {
  const samples = generateDemoAudioSamples(22050, 20);
  const result = analyzeAudioSamples(samples, 22050, 20);

  assert.ok(result.waveformPeaks.length === 900);
  assert.ok(result.onsets.length >= 20, `Expected >= 20 onsets, got ${result.onsets.length}`);
  assert.ok(
    result.bpm >= 122 && result.bpm <= 134,
    `Expected demo BPM near 128, got ${result.bpm}`
  );
});

test('5-Fret and 6-Fret GHL generators scale across all difficulties and obey GHL rules', () => {
  const samples = generateDemoAudioSamples(22050, 20);
  const analysis = analyzeAudioSamples(samples, 22050, 20);
  const configs = createDefaultDifficultyConfigs();
  const bpmMarkers = [{tick: 0, bpm: analysis.bpm}];

  const tracks = generateAllCharts(
    analysis.onsets,
    configs,
    bpmMarkers,
    analysis.offsetMs,
    analysis.durationSec,
    DEFAULT_RESOLUTION
  );

  const counts5 = DIFFICULTIES.map((d) => getUniqueNoteCount(tracks.fiveFret[d].notes));
  const countsGhl = DIFFICULTIES.map((d) => getUniqueNoteCount(tracks.ghl[d].notes));

  assert.ok(counts5[0] > 0 && counts5[3] >= counts5[0], `5-Fret scaling: ${counts5.join(',')}`);
  assert.ok(countsGhl[0] > 0 && countsGhl[3] >= countsGhl[0], `GHL scaling: ${countsGhl.join(',')}`);

  // Easy must be chill yet engaging (>= 38% of Expert note count, not empty/boring)
  assert.ok(
    counts5[0] >= Math.floor(counts5[3] * 0.38) && counts5[0] < counts5[3],
    `5-Fret Easy (${counts5[0]}) should be chill yet active vs Expert (${counts5[3]})`
  );
  assert.ok(
    countsGhl[0] >= Math.floor(countsGhl[3] * 0.38) && countsGhl[0] < countsGhl[3],
    `GHL Easy (${countsGhl[0]}) should be chill yet active vs Expert (${countsGhl[3]})`
  );

  // GHL Easy stays predominantly on White frets with occasional chill Black accents
  const easyWhiteCount = tracks.ghl.Easy.notes.filter((n) => n.fret.startsWith('W')).length;
  const easyBlackCount = tracks.ghl.Easy.notes.filter((n) => n.fret.startsWith('B')).length;
  assert.ok(easyWhiteCount > easyBlackCount, 'GHL Easy should predominantly use White frets');

  // GHL Expert uses both White and Black frets and never combines OPEN with fretted notes at same tick
  const expertGhl = tracks.ghl.Expert;
  const hasBlackOrWhite =
    expertGhl.notes.some((n) => n.fret.startsWith('B')) &&
    expertGhl.notes.some((n) => n.fret.startsWith('W'));
  assert.equal(hasBlackOrWhite, true);

  const byTick = new Map<number, string[]>();
  for (const n of expertGhl.notes) {
    const arr = byTick.get(n.tick) || [];
    arr.push(n.fret);
    byTick.set(n.tick, arr);
  }
  for (const frets of byTick.values()) {
    if (frets.includes('OPEN')) {
      assert.equal(frets.length, 1, 'OPEN note must not share a tick with fretted notes');
    }
  }
});

test('LRC parser and Clone Hero .chart + song.ini serialization emit exact GHL lane 8 and lyric events', () => {
  const lrc = '[00:02.50] Leuchtende Gitarre\n[00:05.00] Vollgas voraus';
  const parsed = parseLrcString(lrc);
  assert.equal(parsed.length, 2);

  const bpmMarkers = [{tick: 0, bpm: 120}];
  const phrases = lrcLinesToPhrases(parsed, bpmMarkers, DEFAULT_RESOLUTION, 0, 30);
  assert.equal(phrases.length, 2);
  assert.ok(phrases[0].syllables.length >= 2);

  const configs = createDefaultDifficultyConfigs();
  const ghlExpert = generateGhlTrack(
    [
      {timeSec: 1.0, strength: 0.9, centroid: 0.98, lowEnergy: 0.3, midEnergy: 0.7, highEnergy: 0.95, sustainSec: 0.2},
      {timeSec: 1.5, strength: 0.85, centroid: 0.1, lowEnergy: 0.9, midEnergy: 0.4, highEnergy: 0.2, sustainSec: 0.8},
    ],
    configs.ghl.Expert,
    bpmMarkers,
    0,
    20,
    DEFAULT_RESOLUTION
  );

  // Force a B3 note explicitly to verify lane 8 serialization
  ghlExpert.notes.push({
    id: 'test-b3',
    tick: 1920,
    fret: 'B3',
    sustain: 96,
    forced: true,
    tap: false,
  });

  assert.equal(GHL_FRET_TO_CHART_LANE.B3, 8);

  const chartText = serializeChartFile({
    metadata: {
      title: 'Test Track',
      artist: 'Test Band',
      album: 'Test LP',
      year: '2026',
      genre: 'Rock',
      charter: 'CloneForge Studio',
      diffGuitar: 4,
      diffGuitarGhl: 5,
      previewStartMs: 5000,
      includeVideo: true,
      coverDataUrl: null,
      coverMime: null,
      mbid: null,
      releaseMbid: null,
    },
    bpmMarkers,
    lyrics: phrases,
    tracks: {
      fiveFret: {
        Easy: {notes: [], starPower: []},
        Medium: {notes: [], starPower: []},
        Hard: {notes: [], starPower: []},
        Expert: {notes: [{id: '5f1', tick: 384, fret: 'G', sustain: 0, forced: false, tap: false}], starPower: []},
      },
      ghl: {
        Easy: {notes: [], starPower: []},
        Medium: {notes: [], starPower: []},
        Hard: {notes: [], starPower: []},
        Expert: ghlExpert,
      },
    },
    offsetMs: 0,
    resolution: DEFAULT_RESOLUTION,
    audioFilename: 'song.wav',
  });

  assert.ok(chartText.includes('[ExpertSingle]'));
  assert.ok(chartText.includes('[ExpertGHLGuitar]'));
  assert.ok(chartText.includes('1920 = N 8 96'), 'Black 3 must serialize as lane 8');
  assert.ok(chartText.includes('1920 = N 5 0'), 'Forced flag must serialize as lane 5');
  assert.ok(chartText.includes('E "phrase_start"'));
  assert.ok(chartText.includes('E "lyric '));

  const ini = serializeSongIni(
    {
      title: 'Test Track',
      artist: 'Test Band',
      album: 'Test LP',
      year: '2026',
      genre: 'Rock',
      charter: 'CloneForge Studio',
      diffGuitar: 4,
      diffGuitarGhl: 5,
      previewStartMs: 5000,
      includeVideo: true,
      coverDataUrl: null,
      coverMime: null,
      mbid: null,
      releaseMbid: null,
    },
    20,
    true
  );

  assert.ok(ini.includes('diff_guitar = 4'));
  assert.ok(ini.includes('diff_guitarghl = 5'));
  assert.ok(ini.includes('video_start_time = 0'));
});

test('filename noise cleaning strips video/lyric suffixes cleanly', () => {
  assert.equal(cleanMediaTitle('Another Life (official video)'), 'Another Life');
  assert.equal(cleanMediaTitle('Another Life [4K] (Official Music Video)'), 'Another Life');

  const parsed = parseFilenameMetadata('Motionless in White - Another Life (official video).mp4');
  assert.equal(parsed.artist, 'Motionless in White');
  assert.equal(parsed.title, 'Another Life');

  const underscoreParsed = parseFilenameMetadata('Linkin_Park_-_Numb_(Lyrics).mp3');
  assert.equal(underscoreParsed.artist, 'Linkin Park');
  assert.equal(underscoreParsed.title, 'Numb');
});

test('autoSelect prioritizes original studio albums over compilations and videos and filters non-music genres', () => {
  const studioRelease = {
    id: 'rel-disguise',
    title: 'Disguise',
    date: '2019-06-07',
    status: 'Official',
    'release-group': {id: 'rg-1', 'primary-type': 'Album', 'secondary-types': []},
    'cover-art-archive': {artwork: true, front: true},
  };
  const compilationRelease = {
    id: 'rel-comp',
    title: 'Thunder - Rock Hits',
    date: '2024-01-01',
    status: 'Official',
    'release-group': {id: 'rg-2', 'primary-type': 'Album', 'secondary-types': ['Compilation']},
    'cover-art-archive': {artwork: true, front: true},
  };

  assert.ok(
    scoreMusicBrainzRelease(studioRelease, 'Motionless in White Another Life') >
      scoreMusicBrainzRelease(compilationRelease, 'Motionless in White Another Life'),
    'Studio album must outrank compilation release'
  );

  const studioRec = {
    id: 'rec-studio',
    title: 'Another Life',
    score: 95,
    length: 205000,
    video: false,
    releases: [studioRelease],
  };
  const videoRec = {
    id: 'rec-video',
    title: 'Another Life (official video)',
    score: 100,
    length: 230000,
    video: true,
    releases: [compilationRelease],
  };

  assert.ok(
    scoreMusicBrainzRecording(studioRec, 205, 'Motionless in White Another Life') >
      scoreMusicBrainzRecording(videoRec, 205, 'Motionless in White Another Life'),
    'Studio recording matching duration must outrank video/compilation entry'
  );

  const genre = extractBestMusicGenre(
    [
      {name: 'music video', count: 10},
      {name: 'metalcore', count: 5},
    ],
    [{name: 'rock', count: 2}]
  );
  assert.equal(genre, 'Metalcore');

  const bestLrc = pickBestLyricsResult(
    [
      {
        id: 1,
        trackName: 'Another Life',
        artistName: 'Motionless in White',
        albumName: 'Disguise',
        duration: 205,
        instrumental: false,
        hasSynced: false,
        syncedLyrics: '',
        plainLyrics: 'Plain only',
      },
      {
        id: 2,
        trackName: 'Another Life',
        artistName: 'Motionless in White',
        albumName: 'Disguise',
        duration: 205,
        instrumental: false,
        hasSynced: true,
        syncedLyrics: '[00:10.00] I remember when',
        plainLyrics: 'I remember when',
      },
      {
        id: 3,
        trackName: 'Another Life (Acoustic)',
        artistName: 'Motionless in White',
        albumName: 'Acoustic',
        duration: 245,
        instrumental: false,
        hasSynced: true,
        syncedLyrics: '[00:12.00] Acoustic line',
        plainLyrics: 'Acoustic line',
      },
    ],
    205,
    'Another Life'
  );
  assert.equal(bestLrc?.id, 2);
});

test('no sustained note ever overlaps or crowds the next note or next sustained note', () => {
  const samples = generateDemoAudioSamples(22050, 20);
  const analysis = analyzeAudioSamples(samples, 22050, 20);
  const configs = createDefaultDifficultyConfigs();
  const tracks = generateAllCharts(
    analysis.onsets,
    configs,
    [{tick: 0, bpm: analysis.bpm}],
    analysis.offsetMs,
    analysis.durationSec,
    DEFAULT_RESOLUTION
  );

  const checkNoOverlap = (notes: {tick: number; sustain: number}[], label: string) => {
    const byTick = new Map<number, number>();
    for (const n of notes) {
      byTick.set(n.tick, Math.max(byTick.get(n.tick) || 0, n.sustain));
    }
    const ticks = [...byTick.keys()].sort((a, b) => a - b);
    for (let i = 0; i < ticks.length - 1; i++) {
      const curTick = ticks[i];
      const nextTick = ticks[i + 1];
      const sus = byTick.get(curTick) || 0;
      if (sus > 0) {
        const nextSus = byTick.get(nextTick) || 0;
        const minGap = nextSus > 0 ? 72 : 48;
        assert.ok(
          curTick + sus + minGap <= nextTick,
          `${label}: sustain at ${curTick} (${sus}) intrudes on ${nextTick} (nextSus=${nextSus})`
        );
      }
    }
  };

  for (const diff of DIFFICULTIES) {
    checkNoOverlap(tracks.fiveFret[diff].notes, `5fret-${diff}`);
    checkNoOverlap(tracks.ghl[diff].notes, `ghl-${diff}`);
  }

  // Also test direct back-to-back sustained notes enforcement
  const crowded = enforceNonOverlappingSustains(
    [
      {id: '1', tick: 0, fret: 'W1', sustain: 384, forced: false, tap: false},
      {id: '2', tick: 288, fret: 'W2', sustain: 384, forced: false, tap: false},
      {id: '3', tick: 576, fret: 'B1', sustain: 0, forced: false, tap: false},
    ],
    DEFAULT_RESOLUTION
  );
  // Gap between 0 and 288 (long->long) requires 72 ticks -> max sustain 216
  assert.ok(crowded[0].sustain <= 216, `Expected clamped sustain <= 216, got ${crowded[0].sustain}`);
  assert.ok(crowded[1].sustain <= 240, `Expected clamped sustain <= 240, got ${crowded[1].sustain}`);
});

test('DSP distinguishes short staccato passages (0 sustain) from genuinely sustained tones', () => {
  const sr = 22050;
  const durationSec = 10;
  const samples = new Float32Array(sr * durationSec);

  // First 5s: short crisp staccato hits every 0.6s (80ms tone, 520ms silence)
  for (const hitSec of [0.5, 1.1, 1.7, 2.3, 2.9, 3.5, 4.1]) {
    const start = Math.floor(hitSec * sr);
    const len = Math.floor(0.11 * sr);
    for (let j = 0; j < len && start + j < samples.length; j++) {
      const env = Math.exp((-j / sr) * 32);
      samples[start + j] += Math.sin(2 * Math.PI * 330 * (j / sr)) * env * 0.85;
    }
  }

  // Second half (5.5s, 7.5s): long held 1.1s guitar tones
  for (const holdSec of [5.5, 7.5]) {
    const start = Math.floor(holdSec * sr);
    const len = Math.floor(1.15 * sr);
    for (let j = 0; j < len && start + j < samples.length; j++) {
      const env = j / sr < 1.05 ? 0.85 : Math.max(0, 0.85 * (1 - (j / sr - 1.05) / 0.1));
      samples[start + j] +=
        (Math.sin(2 * Math.PI * 220 * (j / sr)) + 0.5 * Math.sin(2 * Math.PI * 440 * (j / sr))) *
        env *
        0.55;
    }
  }

  const analysis = analyzeAudioSamples(samples, sr, durationSec);
  const staccatoOnsets = analysis.onsets.filter((o) => o.timeSec >= 0.4 && o.timeSec <= 4.4);
  const heldOnsets = analysis.onsets.filter((o) => o.timeSec >= 5.3 && o.timeSec <= 8.0);

  assert.ok(staccatoOnsets.length >= 5, `Expected staccato onsets, got ${staccatoOnsets.length}`);
  assert.ok(heldOnsets.length >= 2, `Expected held onsets, got ${heldOnsets.length}`);
  assert.ok(
    staccatoOnsets.every((o) => o.sustainSec === 0),
    `Staccato hits must have 0 sustain, got ${staccatoOnsets.map((o) => o.sustainSec).join(',')}`
  );
  assert.ok(
    heldOnsets.some((o) => o.sustainSec >= 0.6),
    `Held tones must detect real sustain, got ${heldOnsets.map((o) => o.sustainSec).join(',')}`
  );

  const configs = createDefaultDifficultyConfigs();
  const ghl = generateGhlTrack(
    analysis.onsets,
    configs.ghl.Expert,
    [{tick: 0, bpm: 120}],
    0,
    durationSec,
    DEFAULT_RESOLUTION
  );
  const staccatoTickCutoff = timeSecToTick(4.6, [{tick: 0, bpm: 120}], DEFAULT_RESOLUTION, 0);
  const earlySustains = ghl.notes.filter((n) => n.tick < staccatoTickCutoff && n.sustain > 0);
  assert.equal(earlySustains.length, 0, 'Short-note passage must have zero sustained notes');
});

test('DSP and Expert generator capture rapid short 16th-note bursts without dropping middle notes', () => {
  const sr = 22050;
  const durationSec = 4;
  const samples = new Float32Array(sr * durationSec);
  const freqs = [220, 261.6, 293.7, 329.6, 392.0, 440.0, 493.9, 523.3, 587.3, 659.3];

  // 10 rapid hits spaced 95ms apart starting at 0.6s
  for (let idx = 0; idx < freqs.length; idx++) {
    const start = Math.floor((0.6 + idx * 0.095) * sr);
    const len = Math.floor(0.075 * sr);
    for (let j = 0; j < len && start + j < samples.length; j++) {
      const env = Math.exp((-j / sr) * 28);
      samples[start + j] += Math.sin(2 * Math.PI * freqs[idx] * (j / sr)) * env * 0.85;
    }
  }

  const analysis = analyzeAudioSamples(samples, sr, durationSec);
  const burstOnsets = analysis.onsets.filter((o) => o.timeSec >= 0.5 && o.timeSec <= 1.7);
  assert.ok(burstOnsets.length >= 8, `Expected >= 8 rapid burst onsets, got ${burstOnsets.length}`);

  const configs = createDefaultDifficultyConfigs();
  const track5 = generateFiveFretTrack(
    analysis.onsets,
    configs.fiveFret.Expert,
    [{tick: 0, bpm: 120}],
    0,
    durationSec,
    DEFAULT_RESOLUTION
  );
  assert.ok(getUniqueNoteCount(track5.notes) >= 8, 'Expert track must keep fast short notes');
  assert.ok(
    track5.notes.every((n) => n.sustain === 0),
    'Fast short burst must not generate sustain tails'
  );
});

test('riff motif detector locks repeating riff patterns consistently across bars', () => {
  const baseRiff = [
    {dt: 0.25, centroid: 0.18, lowEnergy: 0.86, highEnergy: 0.25}, // low pedal
    {dt: 0.25, centroid: 0.50, lowEnergy: 0.35, highEnergy: 0.45}, // mid
    {dt: 0.25, centroid: 0.88, lowEnergy: 0.20, highEnergy: 0.80}, // high
    {dt: 0.25, centroid: 0.19, lowEnergy: 0.84, highEnergy: 0.25}, // low pedal
    {dt: 0.25, centroid: 0.65, lowEnergy: 0.30, highEnergy: 0.60}, // mid-high
    {dt: 0.50, centroid: 0.90, lowEnergy: 0.20, highEnergy: 0.82}, // high turnaround
  ];

  const onsets = [];
  let t = 0.5;
  for (let rep = 0; rep < 3; rep++) {
    for (let k = 0; k < baseRiff.length; k++) {
      const step = baseRiff[k];
      // Add slight mix jitter on repetitions 2 & 3
      const jitter = rep === 0 ? 0 : (k % 2 === 0 ? 0.02 : -0.02);
      onsets.push({
        timeSec: t,
        strength: 0.72,
        centroid: Math.max(0.05, Math.min(0.95, step.centroid + jitter)),
        lowEnergy: step.lowEnergy,
        midEnergy: 0.75,
        highEnergy: step.highEnergy,
        sustainSec: 0,
      });
      t += step.dt;
    }
  }

  const configs = createDefaultDifficultyConfigs();
  const trackGhl = generateGhlTrack(
    onsets,
    configs.ghl.Expert,
    [{tick: 0, bpm: 120}],
    0,
    12,
    DEFAULT_RESOLUTION
  );

  // Group frets per note position and compare riff repetition 1 (idx 0..5) vs repetition 2 (idx 6..11)
  const ticks = Array.from(new Set(trackGhl.notes.map((n) => n.tick))).sort((a, b) => a - b);
  assert.equal(ticks.length, 18);

  const fretAt = (idx: number) =>
    trackGhl.notes
      .filter((n) => n.tick === ticks[idx])
      .map((n) => n.fret)
      .sort()
      .join('+');

  for (let k = 0; k < 6; k++) {
    assert.equal(
      fretAt(6 + k),
      fretAt(k),
      `Riff repetition 2 position ${k} (${fretAt(6 + k)}) must match repetition 1 (${fretAt(k)})`
    );
    assert.equal(
      fretAt(12 + k),
      fretAt(k),
      `Riff repetition 3 position ${k} (${fretAt(12 + k)}) must match repetition 1 (${fretAt(k)})`
    );
  }
});

test('deep full-song tempogram detects 148 BPM accurately even after a 5-second quiet intro', () => {
  const sr = 22050;
  const durationSec = 28;
  const samples = new Float32Array(sr * durationSec);

  // First 5 seconds: soft atmospheric intro pad (no clear beat)
  for (let i = 0; i < 5 * sr; i++) {
    const t = i / sr;
    samples[i] = Math.sin(2 * Math.PI * 220 * t) * 0.08 * Math.min(1, t / 2);
  }

  // From 5.15s onward: tight 148 BPM kick (even beats) + snare (odd beats) + guitar chug
  const bpm = 148;
  const beatSec = 60 / bpm;
  for (let b = 0; ; b++) {
    const tBeat = 5.15 + b * beatSec;
    if (tBeat >= durationSec - 0.5) break;
    const start = Math.floor(tBeat * sr);
    const len = Math.floor(0.14 * sr);
    for (let j = 0; j < len && start + j < samples.length; j++) {
      const jt = j / sr;
      const env = Math.exp(-jt * 26);
      if (b % 2 === 0) {
        // Kick + low riff
        samples[start + j] += Math.sin(2 * Math.PI * (58 + 80 * Math.exp(-jt * 35)) * jt) * env * 0.75;
      } else {
        // Snare + bright accent
        const nVal = Math.sin((start + j) * 12.9898) * 43758.5453;
        const white = (nVal - Math.floor(nVal)) * 2 - 1;
        samples[start + j] += (Math.sin(2 * Math.PI * 210 * jt) * 0.45 + white * 0.55) * env * 0.6;
      }
    }
  }

  const analysis = analyzeAudioSamples(samples, sr, durationSec);
  assert.ok(
    Math.abs(analysis.bpm - 148) <= 0.6,
    `Expected full-song tempogram near 148 BPM despite quiet intro, got ${analysis.bpm}`
  );
  assert.ok(analysis.bpmMarkers && analysis.bpmMarkers.length === 1, 'Steady 148 BPM track should stay single-marker');
});

test('dynamic tempo-drift tracker emits BPM markers when track shifts from 120 to 126 BPM', () => {
  const sr = 22050;
  const durationSec = 40;
  const samples = new Float32Array(sr * durationSec);

  // Construct exact beat times: 44 beats at 120 BPM (0..22s), then remaining beats at 126 BPM
  const beatTimes: number[] = [];
  let tCur = 0.1;
  for (let b = 0; tCur < durationSec - 0.5; b++) {
    beatTimes.push(tCur);
    const curBpm = b < 44 ? 120 : 126;
    tCur += 60 / curBpm;
  }

  beatTimes.forEach((tBeat, b) => {
    const start = Math.floor(tBeat * sr);
    const len = Math.floor(0.12 * sr);
    for (let j = 0; j < len && start + j < samples.length; j++) {
      const jt = j / sr;
      const env = Math.exp(-jt * 26);
      if (b % 2 === 0) {
        samples[start + j] += Math.sin(2 * Math.PI * 82 * jt) * env * 0.75;
      } else {
        const nVal = Math.sin((start + j) * 12.9898) * 43758.5453;
        const white = (nVal - Math.floor(nVal)) * 2 - 1;
        samples[start + j] += (Math.sin(2 * Math.PI * 220 * jt) * 0.45 + white * 0.55) * env * 0.6;
      }
    }
  });

  const analysis = analyzeAudioSamples(samples, sr, durationSec);
  const markers = analysis.bpmMarkers ?? [];
  assert.ok(markers.length >= 2, `Expected dynamic BPM marker adaptation on 120->126 BPM shift, got ${JSON.stringify(markers)}`);
  assert.ok(
    markers[markers.length - 1].bpm > markers[0].bpm + 2,
    `Expected later BPM marker to speed up toward 126 BPM, got ${JSON.stringify(markers)}`
  );
});

test('attack-bloom and 100ms 1/16th vocal/chord swells do not produce stacked double notes', () => {
  const configs = createDefaultDifficultyConfigs();
  const bpmMarkers = [{tick: 0, bpm: 150}]; // 1 beat = 0.4s (192 ticks), 1/16th = 0.1s (48 ticks)

  // Beat 1 (0.40s -> tick 192) + 98ms chord/vocal swell landing on next 1/16th slot (0.498s -> tick 240)
  // + Beat 2 (0.80s -> tick 384) + 55ms bloom (0.855s) + Beat 3 (1.20s -> tick 576)
  const onsets = [
    {timeSec: 0.40, strength: 0.85, centroid: 0.48, lowEnergy: 0.4, midEnergy: 0.8, highEnergy: 0.4, sustainSec: 0.15},
    {timeSec: 0.498, strength: 0.58, centroid: 0.50, lowEnergy: 0.35, midEnergy: 0.65, highEnergy: 0.35, sustainSec: 0.6},
    {timeSec: 0.80, strength: 0.84, centroid: 0.62, lowEnergy: 0.4, midEnergy: 0.8, highEnergy: 0.4, sustainSec: 0},
    {timeSec: 0.855, strength: 0.46, centroid: 0.63, lowEnergy: 0.35, midEnergy: 0.6, highEnergy: 0.35, sustainSec: 0},
    {timeSec: 1.20, strength: 0.86, centroid: 0.30, lowEnergy: 0.5, midEnergy: 0.8, highEnergy: 0.3, sustainSec: 0},
  ];

  const trackGhl = generateGhlTrack(onsets, configs.ghl.Expert, bpmMarkers, 0, 5, DEFAULT_RESOLUTION);
  const ticks = Array.from(new Set(trackGhl.notes.map((n) => n.tick))).sort((a, b) => a - b);

  assert.deepEqual(
    ticks,
    [192, 384, 576],
    `Isolated 1/16th swell at 0.498s and 55ms bloom at 0.855s must be merged into beat hits; got ticks ${ticks.join(',')}`
  );
});

test('GHL fret generator distributes notes across all 3 columns and avoids W2 monotony', () => {
  const samples = generateDemoAudioSamples(22050, 24);
  const analysis = analyzeAudioSamples(samples, 22050, 24);
  const configs = createDefaultDifficultyConfigs();
  const ghlExpert = generateGhlTrack(
    analysis.onsets,
    configs.ghl.Expert,
    analysis.bpmMarkers ?? [{tick: 0, bpm: analysis.bpm}],
    analysis.offsetMs,
    analysis.durationSec,
    DEFAULT_RESOLUTION
  );

  const fretted = ghlExpert.notes.filter((n) => n.fret !== 'OPEN');
  const col1 = fretted.filter((n) => n.fret === 'W1' || n.fret === 'B1').length;
  const col2 = fretted.filter((n) => n.fret === 'W2' || n.fret === 'B2').length;
  const col3 = fretted.filter((n) => n.fret === 'W3' || n.fret === 'B3').length;
  const w2Only = fretted.filter((n) => n.fret === 'W2').length;

  assert.ok(col1 > 0 && col2 > 0 && col3 > 0, `Expected all 3 GHL columns active: col1=${col1}, col2=${col2}, col3=${col3}`);
  assert.ok(
    w2Only < fretted.length * 0.45,
    `W2 must not dominate >45% of fretted notes (got ${w2Only}/${fretted.length})`
  );

  // Group notes by tick to inspect simultaneous White+Black chords (Barre & Diagonal)
  const byTick = new Map<number, string[]>();
  for (const n of ghlExpert.notes) {
    const arr = byTick.get(n.tick) || [];
    arr.push(n.fret);
    byTick.set(n.tick, arr);
  }

  let barreChordCount = 0; // Same-column stacked White+Black (W1+B1, W2+B2, W3+B3)
  let diagonalWbChordCount = 0; // 2-finger cross-column White+Black (e.g., W1+B2, B1+W2, W2+B3, B2+W3)
  let sameRowChordCount = 0; // 2-finger same-row double notes (e.g., W1+W2, B1+B2)

  for (const frets of byTick.values()) {
    if (frets.length < 2) continue;
    const hasWhite = frets.some((f) => f.startsWith('W'));
    const hasBlack = frets.some((f) => f.startsWith('B'));
    const hasBarrePair =
      (frets.includes('W1') && frets.includes('B1')) ||
      (frets.includes('W2') && frets.includes('B2')) ||
      (frets.includes('W3') && frets.includes('B3'));
    if (hasBarrePair) {
      barreChordCount++;
    } else if (hasWhite && hasBlack) {
      diagonalWbChordCount++;
    } else {
      sameRowChordCount++;
    }
  }

  // Stacked same-column Barre chords must stay rare & well-spaced (<= 8% of note ticks)
  assert.ok(
    barreChordCount <= Math.ceil(byTick.size * 0.08),
    `Stacked same-column Barre chords must be strictly capped (<= 8% of ticks), got ${barreChordCount}/${byTick.size}`
  );
  // Ergonomic 2-finger chords (diagonal W+B + same-row double notes) must outnumber stacked Barre chords
  assert.ok(
    diagonalWbChordCount + sameRowChordCount > barreChordCount && diagonalWbChordCount >= 2,
    `Expected ergonomic 2-finger chords (${diagonalWbChordCount} diagonal + ${sameRowChordCount} same-row) to outnumber stacked Barre chords (${barreChordCount})`
  );

  // Easy & Medium GHL tracks must have 0 stacked same-column Barre chords
  const ghlMedium = generateGhlTrack(
    analysis.onsets,
    configs.ghl.Medium,
    analysis.bpmMarkers ?? [{tick: 0, bpm: analysis.bpm}],
    analysis.offsetMs,
    analysis.durationSec,
    DEFAULT_RESOLUTION
  );
  const mediumByTick = new Map<number, string[]>();
  for (const n of ghlMedium.notes) {
    const arr = mediumByTick.get(n.tick) || [];
    arr.push(n.fret);
    mediumByTick.set(n.tick, arr);
  }
  const mediumBarreCount = [...mediumByTick.values()].filter(
    (frets) =>
      (frets.includes('W1') && frets.includes('B1')) ||
      (frets.includes('W2') && frets.includes('B2')) ||
      (frets.includes('W3') && frets.includes('B3'))
  ).length;
  assert.equal(mediumBarreCount, 0, 'Medium GHL must not force single-finger stacked Barre chords');
});

test('Audio-ID fingerprint, binary ID3v2 tag extractor, and messy filename parser work reliably', () => {
  // 1. Test messy filenames (track numbers, downloader prefixes, single hyphen, placeholders)
  const f1 = parseFilenameMetadata('01 - Motionless in White - Another Life (Official Video) [1080p].mp4');
  assert.equal(f1.artist, 'Motionless in White');
  assert.equal(f1.title, 'Another Life');

  const f2 = parseFilenameMetadata('[y2mate.com] Motionless in White-Another Life (320kbps).mp3');
  assert.equal(f2.artist, 'Motionless in White');
  assert.equal(f2.title, 'Another Life');

  assert.equal(sanitizeArtistForQuery('Unbekannter Interpret'), '');
  assert.equal(sanitizeArtistForQuery('Motionless in White'), 'Motionless in White');

  // 2. Construct a binary ID3v2.3 tag buffer with TIT2, TPE1, TALB, TSRC (ISRC), and UFID (MusicBrainz ID)
  const makeId3Frame = (id: string, text: string) => {
    const textBytes = Buffer.from(text, 'utf8');
    const payload = Buffer.concat([Buffer.from([0x03]), textBytes]); // 0x03 = UTF-8
    const header = Buffer.alloc(10);
    header.write(id, 0, 4, 'ascii');
    header.writeUInt32BE(payload.length, 4);
    return Buffer.concat([header, payload]);
  };

  const frames = Buffer.concat([
    makeId3Frame('TIT2', 'Another Life'),
    makeId3Frame('TPE1', 'Motionless in White'),
    makeId3Frame('TALB', 'Disguise'),
    makeId3Frame('TYER', '2019'),
    makeId3Frame('TSRC', 'NLA321900085'),
  ]);

  const id3Header = Buffer.alloc(10);
  id3Header.write('ID3', 0, 3, 'ascii');
  id3Header[3] = 3; // v2.3
  const size = frames.length;
  id3Header[6] = (size >> 21) & 0x7f;
  id3Header[7] = (size >> 14) & 0x7f;
  id3Header[8] = (size >> 7) & 0x7f;
  id3Header[9] = size & 0x7f;

  const fullTagBuf = Buffer.concat([id3Header, frames, Buffer.alloc(64)]);
  const arrayBuffer = fullTagBuf.buffer.slice(
    fullTagBuf.byteOffset,
    fullTagBuf.byteOffset + fullTagBuf.byteLength
  );

  const extracted = extractEmbeddedMediaTags(arrayBuffer);
  assert.equal(extracted.title, 'Another Life');
  assert.equal(extracted.artist, 'Motionless in White');
  assert.equal(extracted.album, 'Disguise');
  assert.equal(extracted.year, '2019');
  assert.equal(extracted.isrc, 'NLA321900085');

  // 3. Test acoustic Audio-ID fingerprint & silent video intro detection
  const sr = 22050;
  const totalSec = 24;
  const samples = new Float32Array(sr * totalSec);
  const demo = generateDemoAudioSamples(sr, 18);
  // Leave first 4 seconds silent (like a video intro), then 18s of music, then 2s silent outro
  samples.set(demo, 4 * sr);

  const fp = computeAudioFingerprint(samples, sr);
  assert.ok(fp.audioId.startsWith('CF1-'), `Expected CF1- Audio-ID prefix, got ${fp.audioId}`);
  assert.ok(
    fp.musicStartSec >= 3.5 && fp.musicStartSec <= 4.5,
    `Expected musicStartSec near 4.0s, got ${fp.musicStartSec}`
  );
  assert.ok(
    fp.activeDurationSec >= 17 && fp.activeDurationSec <= 19,
    `Expected activeDurationSec near 18s, got ${fp.activeDurationSec}`
  );
});

test('DSP detects 200 BPM power-metal double-bass tracks without aliasing to 133.3 BPM and parses kebab-case slugs', () => {
  const sr = 22050;
  const durationSec = 24;
  const samples = new Float32Array(sr * durationSec);
  const bpm = 200;
  const beatSec = 60 / bpm; // 0.30s per beat

  for (let b = 0; ; b++) {
    const tBeat = 0.42 + b * beatSec;
    if (tBeat >= durationSec - 0.4) break;
    const start = Math.floor(tBeat * sr);
    const len = Math.floor(0.11 * sr);
    for (let j = 0; j < len && start + j < samples.length; j++) {
      const jt = j / sr;
      const env = Math.exp(-jt * 28);
      if (b % 2 === 0) {
        samples[start + j] += Math.sin(2 * Math.PI * (65 + 75 * Math.exp(-jt * 35)) * jt) * env * 0.8;
      } else {
        const nVal = Math.sin((start + j) * 12.9898) * 43758.5453;
        const white = (nVal - Math.floor(nVal)) * 2 - 1;
        samples[start + j] += (Math.sin(2 * Math.PI * 240 * jt) * 0.45 + white * 0.55) * env * 0.7;
      }
    }
  }

  const analysis = analyzeAudioSamples(samples, sr, durationSec);
  assert.ok(
    Math.abs(analysis.bpm - 200) <= 1.0,
    `Expected 200 BPM power-metal track to detect at ~200 BPM (not 133.3), got ${analysis.bpm}`
  );

  const recomputedOffset = recomputeOffsetMsForBpm(200, analysis.onsets);
  assert.ok(recomputedOffset >= 0 && recomputedOffset <= 1200);

  const slugParsed = parseFilenameMetadata(
    'troopers-of-the-stars-official-video---extreme-power-metal---dragonforce.mp4'
  );
  assert.equal(slugParsed.artist.toLowerCase(), 'troopers of the stars');
  assert.equal(slugParsed.title.toLowerCase(), 'dragonforce');
  assert.equal(
    cleanMediaTitle('troopers-of-the-stars-official-video---extreme-power-metal---dragonforce').toLowerCase(),
    'troopers of the stars - extreme power metal - dragonforce'
  );
});



