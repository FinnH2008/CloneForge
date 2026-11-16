export interface EmbeddedMediaTags {
  title?: string;
  artist?: string;
  album?: string;
  year?: string;
  genre?: string;
  isrc?: string;
  mbid?: string;
  releaseMbid?: string;
  acoustidId?: string;
  lyrics?: string;
  coverDataUrl?: string;
  coverMime?: string;
}

export interface AudioFingerprintResult {
  audioId: string; // Deterministic acoustic signature e.g. CF1-...
  subfingerprints: number[]; // 32-bit chroma gray-code subfingerprints
  chromaProfile: number[]; // 12-element normalized pitch-class profile
  musicStartSec: number; // First active musical transient/rms onset (strips video intro silence)
  musicEndSec: number; // Last active musical frame (strips video outro silence)
  activeDurationSec: number; // Effective musical duration without video intro/outro padding
}

function decodeTextBytes(bytes: Uint8Array, encodingByte?: number): string {
  if (bytes.length === 0) return '';
  try {
    if (encodingByte === 1 || encodingByte === 2) {
      // UTF-16 with BOM or UTF-16BE
      const hasBomLE = bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe;
      const hasBomBE = bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff;
      const slice = hasBomLE || hasBomBE ? bytes.subarray(2) : bytes;
      const dec = new TextDecoder(hasBomBE || encodingByte === 2 ? 'utf-16be' : 'utf-16le');
      return dec.decode(slice).replace(/\0+/g, '').trim();
    }
    if (encodingByte === 0) {
      return new TextDecoder('iso-8859-1').decode(bytes).replace(/\0+/g, '').trim();
    }
    return new TextDecoder('utf-8').decode(bytes).replace(/\0+/g, '').trim();
  } catch {
    let out = '';
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] >= 32 && bytes[i] < 127) out += String.fromCharCode(bytes[i]);
    }
    return out.trim();
  }
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const sub = bytes.subarray(i, Math.min(bytes.length, i + chunkSize));
    for (let j = 0; j < sub.length; j++) {
      binary += String.fromCharCode(sub[j]);
    }
  }
  if (typeof btoa === 'function') {
    return btoa(binary);
  }
  return Buffer.from(bytes).toString('base64');
}

const ID3V1_GENRES: Record<number, string> = {
  0: 'Blues',
  1: 'Classic Rock',
  2: 'Country',
  3: 'Dance',
  4: 'Disco',
  5: 'Funk',
  6: 'Grunge',
  7: 'Hip-Hop',
  8: 'Jazz',
  9: 'Metal',
  11: 'Oldies',
  13: 'Pop',
  14: 'R&B',
  15: 'Rap',
  16: 'Reggae',
  17: 'Rock',
  18: 'Techno',
  19: 'Industrial',
  20: 'Alternative',
  21: 'Ska',
  22: 'Death Metal',
  24: 'Soundtrack',
  32: 'Classical',
  39: 'Noise',
  40: 'AlternRock',
  41: 'Bass',
  42: 'Soul',
  43: 'Punk',
  52: 'Electronic',
  78: 'Rock & Roll',
  79: 'Hard Rock',
};

function normalizeGenreTag(raw: string): string {
  const trimmed = raw.trim();
  const numMatch = trimmed.match(/^\(?(\d{1,3})\)?$/);
  if (numMatch) {
    const idx = Number(numMatch[1]);
    return ID3V1_GENRES[idx] || '';
  }
  const parenPrefix = trimmed.replace(/^\(\d+\)/, '').trim();
  return parenPrefix;
}

/**
 * Extracts embedded binary metadata, ISRC, MusicBrainz IDs, cover art, and lyrics
 * directly from MP3 (ID3v2.2/v2.3/v2.4) and MP4/M4A (ISO BMFF moov/udta/meta/ilst) containers.
 */
export function extractEmbeddedMediaTags(buffer: ArrayBuffer): EmbeddedMediaTags {
  const tags: EmbeddedMediaTags = {};
  if (!buffer || buffer.byteLength < 16) return tags;

  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);

  // 1. Check for ID3v2 header ("ID3")
  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    const version = bytes[3]; // 2, 3, or 4
    const flags = bytes[5];
    const tagSize =
      ((bytes[6] & 0x7f) << 21) |
      ((bytes[7] & 0x7f) << 14) |
      ((bytes[8] & 0x7f) << 7) |
      (bytes[9] & 0x7f);

    let offset = 10;
    if ((flags & 0x40) !== 0 && offset + 4 < bytes.length) {
      // Skip extended header
      const extSize =
        version === 4
          ? ((bytes[offset] & 0x7f) << 21) |
            ((bytes[offset + 1] & 0x7f) << 14) |
            ((bytes[offset + 2] & 0x7f) << 7) |
            (bytes[offset + 3] & 0x7f)
          : view.getUint32(offset, false);
      offset += Math.max(4, extSize);
    }

    const limit = Math.min(bytes.length, 10 + tagSize);
    while (offset + (version === 2 ? 6 : 10) <= limit) {
      if (bytes[offset] === 0) break;

      let frameId = '';
      let frameSize = 0;
      let headerLen = 10;

      if (version === 2) {
        frameId = String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2]);
        frameSize = (bytes[offset + 3] << 16) | (bytes[offset + 4] << 8) | bytes[offset + 5];
        headerLen = 6;
      } else {
        frameId = String.fromCharCode(
          bytes[offset],
          bytes[offset + 1],
          bytes[offset + 2],
          bytes[offset + 3]
        );
        if (version === 4) {
          frameSize =
            ((bytes[offset + 4] & 0x7f) << 21) |
            ((bytes[offset + 5] & 0x7f) << 14) |
            ((bytes[offset + 6] & 0x7f) << 7) |
            (bytes[offset + 7] & 0x7f);
        } else {
          frameSize = view.getUint32(offset + 4, false);
        }
        headerLen = 10;
      }

      if (frameSize <= 0 || offset + headerLen + frameSize > limit) break;
      const payload = bytes.subarray(offset + headerLen, offset + headerLen + frameSize);
      offset += headerLen + frameSize;

      if (payload.length < 2) continue;

      if (
        frameId === 'TIT2' ||
        frameId === 'TT2' ||
        frameId === 'TPE1' ||
        frameId === 'TP1' ||
        frameId === 'TPE2' ||
        frameId === 'TALB' ||
        frameId === 'TAL' ||
        frameId === 'TYER' ||
        frameId === 'TYE' ||
        frameId === 'TDRC' ||
        frameId === 'TCON' ||
        frameId === 'TCO' ||
        frameId === 'TSRC'
      ) {
        const text = decodeTextBytes(payload.subarray(1), payload[0]);
        if (!text) continue;
        if (frameId === 'TIT2' || frameId === 'TT2') tags.title = text;
        else if ((frameId === 'TPE1' || frameId === 'TP1') && !tags.artist) tags.artist = text;
        else if (frameId === 'TPE2' && !tags.artist) tags.artist = text;
        else if (frameId === 'TALB' || frameId === 'TAL') tags.album = text;
        else if (frameId === 'TYER' || frameId === 'TYE' || frameId === 'TDRC') {
          const ym = text.match(/\d{4}/);
          if (ym) tags.year = ym[0];
        } else if (frameId === 'TCON' || frameId === 'TCO') {
          const g = normalizeGenreTag(text);
          if (g) tags.genre = g;
        } else if (frameId === 'TSRC') {
          tags.isrc = text.replace(/[^A-Z0-9]/gi, '').toUpperCase();
        }
      } else if (frameId === 'UFID') {
        // Unique file identifier: owner\0id
        const zeroIdx = payload.indexOf(0);
        if (zeroIdx > 0 && zeroIdx < payload.length - 1) {
          const owner = decodeTextBytes(payload.subarray(0, zeroIdx), 0);
          const idStr = decodeTextBytes(payload.subarray(zeroIdx + 1), 0);
          if (owner.includes('musicbrainz.org') && /^[0-9a-f-]{36}$/i.test(idStr)) {
            tags.mbid = idStr.toLowerCase();
          }
        }
      } else if (frameId === 'TXXX') {
        const enc = payload[0];
        const rest = payload.subarray(1);
        const decoded = decodeTextBytes(rest, enc);
        const lower = decoded.toLowerCase();
        const uuidMatch = decoded.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
        if (uuidMatch) {
          if (lower.includes('acoustid')) {
            tags.acoustidId = uuidMatch[0].toLowerCase();
          } else if (lower.includes('musicbrainz') && lower.includes('album')) {
            tags.releaseMbid = uuidMatch[0].toLowerCase();
          } else if (lower.includes('musicbrainz')) {
            tags.mbid = uuidMatch[0].toLowerCase();
          }
        }
      } else if (frameId === 'USLT' && payload.length > 5) {
        const enc = payload[0];
        // Skip 3-byte language code (bytes 1..3), then description + null terminator
        const body = payload.subarray(4);
        let textStart = 0;
        if (enc === 1 || enc === 2) {
          for (let i = 0; i < body.length - 1; i += 2) {
            if (body[i] === 0 && body[i + 1] === 0) {
              textStart = i + 2;
              break;
            }
          }
        } else {
          const z = body.indexOf(0);
          if (z >= 0) textStart = z + 1;
        }
        const lyr = decodeTextBytes(body.subarray(textStart), enc);
        if (lyr.length >= 12) tags.lyrics = lyr;
      } else if (frameId === 'APIC' && payload.length > 16 && !tags.coverDataUrl) {
        const enc = payload[0];
        const mimeEnd = payload.indexOf(0, 1);
        if (mimeEnd > 1 && mimeEnd + 2 < payload.length) {
          const mime = decodeTextBytes(payload.subarray(1, mimeEnd), 0) || 'image/jpeg';
          let descEnd = mimeEnd + 2; // after picture type byte
          if (enc === 1 || enc === 2) {
            while (descEnd + 1 < payload.length && !(payload[descEnd] === 0 && payload[descEnd + 1] === 0)) {
              descEnd += 2;
            }
            descEnd += 2;
          } else {
            while (descEnd < payload.length && payload[descEnd] !== 0) descEnd++;
            descEnd += 1;
          }
          if (descEnd < payload.length && payload.length - descEnd <= 3 * 1024 * 1024) {
            const imgBytes = payload.subarray(descEnd);
            tags.coverMime = mime.includes('png') ? 'image/png' : 'image/jpeg';
            tags.coverDataUrl = `data:${tags.coverMime};base64,${uint8ToBase64(imgBytes)}`;
          }
        }
      }
    }
    return tags;
  }

  // 2. Check for MP4 / M4A ISO Base Media atoms (ftyp / moov / ilst)
  parseMp4IlstAtoms(bytes, view, tags);
  return tags;
}

function parseMp4IlstAtoms(bytes: Uint8Array, view: DataView, tags: EmbeddedMediaTags): void {
  const maxScan = Math.min(bytes.length, 16 * 1024 * 1024); // Scan up to 16MB for moov/udta/meta/ilst

  const readAtomType = (pos: number): string =>
    String.fromCharCode(bytes[pos], bytes[pos + 1], bytes[pos + 2], bytes[pos + 3]);

  const scanContainer = (start: number, end: number, depth: number) => {
    if (depth > 6) return;
    let pos = start;
    while (pos + 8 <= end) {
      let size = view.getUint32(pos, false);
      const type = readAtomType(pos + 4);
      let headerSize = 8;
      if (size === 1 && pos + 16 <= end) {
        const hi = view.getUint32(pos + 8, false);
        const lo = view.getUint32(pos + 12, false);
        size = hi * 0x100000000 + lo;
        headerSize = 16;
      } else if (size === 0) {
        size = end - pos;
      }
      if (size < headerSize || pos + size > end) break;

      if (type === 'moov' || type === 'udta' || type === 'ilst') {
        scanContainer(pos + headerSize, pos + size, depth + 1);
      } else if (type === 'meta' && pos + headerSize + 4 < pos + size) {
        // 'meta' has a 4-byte version/flags header before child atoms
        scanContainer(pos + headerSize + 4, pos + size, depth + 1);
      } else if (
        type === '\xa9nam' ||
        type === '\xa9ART' ||
        type === 'aART' ||
        type === '\xa9alb' ||
        type === '\xa9day' ||
        type === '\xa9gen' ||
        type === '\xa9lyr' ||
        type === 'covr'
      ) {
        // Inside an ilst item atom, find child 'data' atom
        let dPos = pos + headerSize;
        const itemEnd = pos + size;
        while (dPos + 16 <= itemEnd) {
          const dSize = view.getUint32(dPos, false);
          const dType = readAtomType(dPos + 4);
          if (dSize < 16 || dPos + dSize > itemEnd) break;
          if (dType === 'data') {
            const dataType = view.getUint32(dPos + 8, false);
            const payload = bytes.subarray(dPos + 16, dPos + dSize);
            if (type === 'covr' && !tags.coverDataUrl && payload.length <= 3 * 1024 * 1024) {
              const isPng = dataType === 14 || (payload[0] === 0x89 && payload[1] === 0x50);
              tags.coverMime = isPng ? 'image/png' : 'image/jpeg';
              tags.coverDataUrl = `data:${tags.coverMime};base64,${uint8ToBase64(payload)}`;
            } else {
              const text = decodeTextBytes(payload, 3);
              if (text) {
                if (type === '\xa9nam') tags.title = text;
                else if (type === '\xa9ART' || (type === 'aART' && !tags.artist)) tags.artist = text;
                else if (type === '\xa9alb') tags.album = text;
                else if (type === '\xa9day') {
                  const ym = text.match(/\d{4}/);
                  if (ym) tags.year = ym[0];
                } else if (type === '\xa9gen') tags.genre = text;
                else if (type === '\xa9lyr' && text.length >= 12) tags.lyrics = text;
              }
            }
            break;
          }
          dPos += dSize;
        }
      }
      pos += size;
    }
  };

  scanContainer(0, maxScan, 0);
}

/**
 * Computes a Chromaprint-inspired 12-pitch-class acoustic fingerprint AND detects the active
 * musical window (stripping silent/cinematic video intros & outros in MP4 music videos).
 */
export function computeAudioFingerprint(
  samples: Float32Array,
  sampleRate: number
): AudioFingerprintResult {
  const totalSec = samples.length / Math.max(8000, sampleRate);
  if (samples.length < 4096) {
    return {
      audioId: 'CF1-00000000',
      subfingerprints: [],
      chromaProfile: new Array(12).fill(0),
      musicStartSec: 0,
      musicEndSec: totalSec,
      activeDurationSec: totalSec,
    };
  }

  // 1. Detect active musical start and end (essential for MP4 music videos with intro/outro skits)
  const blockSamples = Math.max(512, Math.floor(sampleRate * 0.25)); // 250ms RMS blocks
  const numBlocks = Math.max(1, Math.floor(samples.length / blockSamples));
  const blockRms = new Float32Array(numBlocks);
  let maxRms = 0.0001;

  for (let b = 0; b < numBlocks; b++) {
    const start = b * blockSamples;
    const end = Math.min(samples.length, start + blockSamples);
    const stride = Math.max(1, Math.floor((end - start) / 128));
    let sumSq = 0;
    let count = 0;
    for (let i = start; i < end; i += stride) {
      const s = samples[i];
      sumSq += s * s;
      count++;
    }
    const rms = Math.sqrt(sumSq / Math.max(1, count));
    blockRms[b] = rms;
    if (rms > maxRms) maxRms = rms;
  }

  // Active music threshold: 12% of peak RMS sustained across at least 2 consecutive blocks
  const activeThresh = maxRms * 0.12;
  let firstActiveBlock = 0;
  for (let b = 0; b < numBlocks - 1; b++) {
    if (blockRms[b] >= activeThresh && blockRms[b + 1] >= activeThresh * 0.85) {
      firstActiveBlock = b;
      break;
    }
  }

  let lastActiveBlock = numBlocks - 1;
  for (let b = numBlocks - 1; b > firstActiveBlock + 1; b--) {
    if (blockRms[b] >= activeThresh && blockRms[b - 1] >= activeThresh * 0.85) {
      lastActiveBlock = b;
      break;
    }
  }

  const musicStartSec = Number(((firstActiveBlock * blockSamples) / sampleRate).toFixed(2));
  const musicEndSec = Number(
    Math.min(totalSec, ((lastActiveBlock + 1) * blockSamples) / sampleRate).toFixed(2)
  );
  const activeDurationSec = Number(Math.max(5, musicEndSec - musicStartSec).toFixed(2));

  // 2. Compute 12-band Chroma profile & 32-bit Gray-coded subfingerprints over up to 90s of active audio
  const startSample = Math.floor(musicStartSec * sampleRate);
  const maxSpanSamples = Math.min(samples.length - startSample, Math.floor(90 * sampleRate));
  const hopSamples = Math.max(512, Math.floor(sampleRate * 0.12)); // ~120ms chroma frames
  const frameLen = 1024;
  const numFrames = Math.max(1, Math.floor((maxSpanSamples - frameLen) / hopSamples));

  const chromaAccum = new Float64Array(12);
  const subfingerprints: number[] = [];
  const prevChroma = new Float32Array(12);

  // Precompute Goertzel / DFT pitch-class probe frequencies across 3 octaves (C2..B4: 65.4Hz..493.9Hz)
  const probeCos = new Float32Array(36 * 256);
  const probeSin = new Float32Array(36 * 256);
  for (let n = 0; n < 36; n++) {
    const freq = 65.406 * Math.pow(2, n / 12);
    const omega = (2 * Math.PI * freq) / sampleRate;
    for (let k = 0; k < 256; k++) {
      const sampleIdx = k * 4;
      probeCos[n * 256 + k] = Math.cos(omega * sampleIdx);
      probeSin[n * 256 + k] = Math.sin(omega * sampleIdx);
    }
  }

  for (let f = 0; f < numFrames; f++) {
    const baseOffset = startSample + f * hopSamples;
    const curChroma = new Float32Array(12);

    for (let n = 0; n < 36; n++) {
      const pitchClass = n % 12;
      let re = 0;
      let im = 0;
      const pBase = n * 256;
      for (let k = 0; k < 256; k++) {
        const s = samples[baseOffset + k * 4] || 0;
        re += s * probeCos[pBase + k];
        im += s * probeSin[pBase + k];
      }
      const mag = Math.sqrt(re * re + im * im);
      curChroma[pitchClass] += mag;
      chromaAccum[pitchClass] += mag;
    }

    // Build 32-bit Chromaprint-style differential subfingerprint across pitch classes & time lag
    let bits = 0;
    for (let c = 0; c < 12; c++) {
      const nextC = (c + 1) % 12;
      const fifthC = (c + 7) % 12;
      const spatialDiff = curChroma[c] - curChroma[nextC];
      const temporalDiff = curChroma[c] - prevChroma[c];
      const fifthDiff = curChroma[c] - curChroma[fifthC];
      if (spatialDiff > 0) bits |= 1 << c;
      if (temporalDiff > 0) bits |= 1 << (12 + c);
      if (c < 8 && fifthDiff > 0) bits |= 1 << (24 + c);
      prevChroma[c] = curChroma[c];
    }
    subfingerprints.push(bits >>> 0);
  }

  let maxChroma = 0.0001;
  for (let c = 0; c < 12; c++) {
    if (chromaAccum[c] > maxChroma) maxChroma = chromaAccum[c];
  }
  const chromaProfile = Array.from(chromaAccum).map((v) => Number((v / maxChroma).toFixed(3)));

  // FNV-1a 64-bit style deterministic Audio-ID signature from chroma profile + subfingerprints
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < subfingerprints.length; i++) {
    h1 = Math.imul(h1 ^ subfingerprints[i], 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ ((subfingerprints[i] >>> 16) | (subfingerprints[i] << 16)), 0x85ebca6b) >>> 0;
  }
  const durHex = Math.round(activeDurationSec)
    .toString(16)
    .padStart(4, '0')
    .toUpperCase();
  const audioId = `CF1-${durHex}-${h1.toString(16).padStart(8, '0').toUpperCase()}${h2
    .toString(16)
    .padStart(8, '0')
    .toUpperCase()}`;

  return {
    audioId,
    subfingerprints: subfingerprints.slice(0, 256),
    chromaProfile,
    musicStartSec,
    musicEndSec,
    activeDurationSec,
  };
}
