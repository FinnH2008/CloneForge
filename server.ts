import express from 'express';
import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';
import {createServer as createViteServer} from 'vite';
import {
  extractBestMusicGenre,
  pickBestLyricsResult,
  scoreMusicBrainzRecording,
  scoreMusicBrainzRelease,
  type RawMusicBrainzRecording,
} from './src/utils/autoSelect';
import {
  cleanMediaTitle,
  parseFilenameMetadata,
  sanitizeArtistForQuery,
} from './src/utils/timing';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const APP_USER_AGENT =
  'CloneForgeStudio/2.0.0 (https://cloneforge.studio; contact@cloneforge.studio)';

// MusicBrainz strict rate limiter: max 1 request per 1100ms
let lastMusicBrainzRequest = 0;
let mbQueue: Promise<unknown> = Promise.resolve();

function scheduleMusicBrainzFetch(url: string): Promise<Response> {
  const run = async () => {
    let lastResponse: Response | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const now = Date.now();
      const waitMs = Math.max(0, lastMusicBrainzRequest + 1120 - now);
      if (waitMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
      lastMusicBrainzRequest = Date.now();
      const res = await fetch(url, {
        headers: {
          'User-Agent': APP_USER_AGENT,
          Accept: 'application/json',
        },
      });
      lastResponse = res;
      if (res.status !== 503 && res.status !== 429) {
        return res;
      }
      await new Promise((resolve) => setTimeout(resolve, 1100 * (attempt + 1)));
    }
    return lastResponse!;
  };
  const next = mbQueue.then(run, run);
  mbQueue = next.catch(() => {});
  return next;
}

async function fetchJsonWithTimeout<T = any>(url: string, timeoutMs: number = 4500): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': APP_USER_AGENT,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchImageAsDataUrl(imageUrl: string, timeoutMs: number = 5000): Promise<{
  dataUrl: string | null;
  mimeType: string | null;
}> {
  if (!imageUrl) return {dataUrl: null, mimeType: null};
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(imageUrl, {
      headers: {'User-Agent': APP_USER_AGENT},
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!response.ok) return {dataUrl: null, mimeType: null};
    const contentType = response.headers.get('content-type') || 'image/jpeg';
    const arrayBuffer = await response.arrayBuffer();
    const base64 = Buffer.from(arrayBuffer).toString('base64');
    return {
      dataUrl: `data:${contentType};base64,${base64}`,
      mimeType: contentType,
    };
  } catch {
    return {dataUrl: null, mimeType: null};
  } finally {
    clearTimeout(timer);
  }
}

interface CanonicalCatalogMatch {
  title: string;
  artist: string;
  album: string;
  year: string;
  genre: string;
  isrc: string;
  bpm: number | null;
  durationSec: number;
  coverUrl: string;
  source: string;
}

function normalizeStudioBpm(rawBpm: unknown): number | null {
  const num = Number(rawBpm);
  if (!Number.isFinite(num) || num < 55 || num > 235) return null;
  return Math.abs(num - Math.round(num)) <= 0.45 ? Math.round(num) : Math.round(num * 10) / 10;
}

function sanitizeLuceneTerm(raw: string): string {
  return raw
    .replace(/[+\-&|!(){}\[\]^"~*?:\\/]/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function stripFeatAndParen(raw: string): string {
  return raw
    .replace(/\s*[\(\[](?:feat\.?|ft\.?|with|prod\.?)[^\)\]]*[\)\]]/gi, '')
    .replace(/\s+(?:feat\.?|ft\.?)\s+.+$/i, '')
    .trim();
}

/**
 * Multi-Catalog Audio-ID & Canonical Track Resolver (Deezer ISRC + Track BPM + iTunes Search).
 * Resolves exact ISRC Audio-ID, canonical artist, title, studio album, year, genre, studio BPM, and cover art
 * even when the user's filename has no separator, reversed order, or YouTube video duration padding.
 */
async function resolveCanonicalCatalogTrack(params: {
  artist?: string;
  title?: string;
  q?: string;
  isrc?: string;
  durationSec?: number;
  activeDurationSec?: number;
}): Promise<CanonicalCatalogMatch | null> {
  const cleanArtist = sanitizeArtistForQuery(params.artist);
  const cleanTitle = cleanMediaTitle(params.title || '');
  const rawQuery = cleanMediaTitle(params.q || [cleanArtist, cleanTitle].filter(Boolean).join(' '));

  // 1. Direct ISRC Audio-ID lookup on Deezer if embedded ISRC is known
  if (params.isrc && /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/i.test(params.isrc)) {
    const isrcData = await fetchJsonWithTimeout<any>(
      `https://api.deezer.com/2.0/track/isrc:${encodeURIComponent(params.isrc.toUpperCase())}`
    );
    if (isrcData && isrcData.title && isrcData.artist?.name) {
      const yearMatch = (isrcData.release_date || '').match(/^(\d{4})/);
      return {
        title: isrcData.title_short || isrcData.title,
        artist: isrcData.artist.name,
        album: isrcData.album?.title || '',
        year: yearMatch ? yearMatch[1] : '',
        genre: '',
        isrc: isrcData.isrc || params.isrc.toUpperCase(),
        bpm: normalizeStudioBpm(isrcData.bpm),
        durationSec: Number(isrcData.duration) || 0,
        coverUrl: isrcData.album?.cover_big || isrcData.album?.cover_medium || '',
        source: 'ISRC Audio-ID',
      };
    }
  }

  if (!rawQuery && !cleanTitle) return null;

  const searchTerms = Array.from(
    new Set(
      [
        cleanArtist && cleanTitle ? `${cleanArtist} ${cleanTitle}` : '',
        cleanArtist && cleanTitle ? `${cleanArtist} ${stripFeatAndParen(cleanTitle)}` : '',
        rawQuery,
      ].filter((s) => s.length >= 2)
    )
  );

  const primarySearch = searchTerms[0] || rawQuery;

  const [deezerRes, itunesRes] = await Promise.all([
    fetchJsonWithTimeout<{data?: any[]}>(
      `https://api.deezer.com/search?q=${encodeURIComponent(primarySearch)}&limit=8`
    ),
    fetchJsonWithTimeout<{results?: any[]}>(
      `https://itunes.apple.com/search?term=${encodeURIComponent(primarySearch)}&entity=song&limit=8`
    ),
  ]);

  const queryTokens = `${primarySearch} ${rawQuery}`
    .toLowerCase()
    .replace(/[^a-z0-9äöüß\s]/g, ' ')
    .split(/\s+/)
    .filter((w, idx, arr) => w.length >= 2 && arr.indexOf(w) === idx);

  const compilationRe =
    /\b(hits|best of|greatest|collection|100 from|thunder|soundtrack|motion picture|karaoke|tribute|instrumental|remix|live|nightcore)\b/i;

  const scoreCandidate = (cand: {
    title: string;
    artist: string;
    album: string;
    durationSec: number;
    hasIsrc: boolean;
  }): number => {
    let score = 0;
    const text = `${cand.artist} ${cand.title} ${cand.album}`.toLowerCase();
    for (const tok of queryTokens) {
      if (text.includes(tok)) score += 16;
    }
    const candTitleLower = cand.title.toLowerCase();
    const candArtistLower = cand.artist.toLowerCase();
    const cleanTitleLower = cleanTitle.toLowerCase();
    const cleanArtistLower = cleanArtist.toLowerCase();

    // Support both standard (Artist - Title) and reversed (Title - Album - Artist) filenames
    if (
      (cleanTitleLower && candTitleLower === cleanTitleLower) ||
      (cleanArtistLower && candTitleLower === cleanArtistLower)
    ) {
      score += 35;
    }
    if (
      (cleanArtistLower && candArtistLower === cleanArtistLower) ||
      (cleanTitleLower && candArtistLower === cleanTitleLower)
    ) {
      score += 35;
    }

    if (compilationRe.test(cand.album) && !compilationRe.test(primarySearch)) score -= 45;
    if (compilationRe.test(cand.title) && !compilationRe.test(primarySearch)) score -= 45;

    if (cand.durationSec > 5) {
      const d1 =
        params.durationSec && params.durationSec > 5
          ? Math.abs(cand.durationSec - params.durationSec)
          : Infinity;
      const d2 =
        params.activeDurationSec && params.activeDurationSec > 5
          ? Math.abs(cand.durationSec - params.activeDurationSec)
          : Infinity;
      const diff = Math.min(d1, d2);
      if (diff <= 4) score += 36;
      else if (diff <= 12) score += 18;
      else if (diff <= 28) score += 6;
      else if (diff > 55) score -= 25;
    }

    if (cand.hasIsrc) score += 10;
    return score;
  };

  let bestDz: any = null;
  let bestDzScore = -Infinity;
  for (const item of deezerRes?.data || []) {
    const s = scoreCandidate({
      title: item.title_short || item.title || '',
      artist: item.artist?.name || '',
      album: item.album?.title || '',
      durationSec: Number(item.duration) || 0,
      hasIsrc: Boolean(item.isrc),
    });
    if (s > bestDzScore) {
      bestDzScore = s;
      bestDz = item;
    }
  }

  let bestIt: any = null;
  let bestItScore = -Infinity;
  for (const item of itunesRes?.results || []) {
    const s = scoreCandidate({
      title: item.trackName || '',
      artist: item.artistName || '',
      album: item.collectionName || '',
      durationSec: Math.round((Number(item.trackTimeMillis) || 0) / 1000),
      hasIsrc: false,
    });
    if (s > bestItScore) {
      bestItScore = s;
      bestIt = item;
    }
  }

  if (!bestDz && !bestIt) return null;

  // Fetch full Deezer track details (/track/:id) to obtain official studio BPM, ISRC, and release date
  let dzDetail: any = null;
  if (bestDz?.id) {
    dzDetail = await fetchJsonWithTimeout<any>(
      `https://api.deezer.com/track/${encodeURIComponent(String(bestDz.id))}`,
      2600
    );
  }

  const title = bestDz?.title_short || bestDz?.title || bestIt?.trackName || cleanTitle;
  const artist = bestDz?.artist?.name || bestIt?.artistName || cleanArtist;
  const rawAlbum =
    (!compilationRe.test(bestIt?.collectionName || '') && bestIt?.collectionName) ||
    bestDz?.album?.title ||
    bestIt?.collectionName ||
    '';
  const album = rawAlbum.replace(/\s+-\s+(Single|EP)$/i, '').trim();
  const yearMatch = (bestIt?.releaseDate || dzDetail?.release_date || '').match(/^(\d{4})/);
  const genre =
    bestIt?.primaryGenreName && !/^(music|pop)$/i.test(bestIt.primaryGenreName)
      ? bestIt.primaryGenreName
      : bestIt?.primaryGenreName || '';
  const isrc = dzDetail?.isrc || bestDz?.isrc || '';
  const bpm = normalizeStudioBpm(dzDetail?.bpm ?? bestDz?.bpm);
  const durationSec =
    Number(bestDz?.duration) || Math.round((Number(bestIt?.trackTimeMillis) || 0) / 1000) || 0;
  const itunesHiResCover = bestIt?.artworkUrl100
    ? String(bestIt.artworkUrl100).replace('100x100bb', '600x600bb')
    : '';
  const coverUrl = bestDz?.album?.cover_big || itunesHiResCover || bestDz?.album?.cover_medium || '';

  return {
    title,
    artist,
    album,
    year: yearMatch ? yearMatch[1] : '',
    genre,
    isrc,
    bpm,
    durationSec,
    coverUrl,
    source: isrc ? `ISRC ${isrc}` : 'Catalog Match',
  };
}

async function searchAndRankMusicBrainz(params: {
  q?: string;
  title?: string;
  artist?: string;
  isrc?: string;
  mbid?: string;
  durationSec?: number;
  activeDurationSec?: number;
  enrichTop?: boolean;
  canonicalHint?: CanonicalCatalogMatch | null;
}) {
  const canonical = params.canonicalHint;
  let title = cleanMediaTitle(params.title || canonical?.title || '');
  let artist = sanitizeArtistForQuery(params.artist || canonical?.artist || '');
  const rawQ = (params.q || '').trim();

  // If caller passed "Artist - Title" inside q without separating title/artist, split it cleanly
  if (rawQ && (!title || !artist)) {
    const parsedFromQ = parseFilenameMetadata(rawQ);
    if (!title && parsedFromQ.title) title = parsedFromQ.title;
    if (!artist && parsedFromQ.artist) artist = parsedFromQ.artist;
  }

  // Use canonical catalog match if artist was still missing or swapped
  if (canonical) {
    if (!artist && canonical.artist) artist = canonical.artist;
    if (!title && canonical.title) title = canonical.title;
  }

  const queryHint = [artist, title, rawQ].filter(Boolean).join(' ');
  const canonicalAlbum = canonical?.album || '';
  let recordings: RawMusicBrainzRecording[] = [];

  // 1. Direct MBID lookup if embedded MBID is provided
  if (params.mbid && /^[0-9a-f-]{36}$/i.test(params.mbid)) {
    try {
      const directRes = await scheduleMusicBrainzFetch(
        `https://musicbrainz.org/ws/2/recording/${params.mbid}?inc=artist-credits+releases+release-groups+tags+genres&fmt=json`
      );
      if (directRes.ok) {
        const directRec = (await directRes.json()) as RawMusicBrainzRecording;
        if (directRec?.id) {
          recordings = [{...directRec, score: 100}];
        }
      }
    } catch {
      // Fall through to search
    }
  }

  // 2. Structured Lucene search by canonical recording & artist
  if (recordings.length === 0) {
    const cleanT = sanitizeLuceneTerm(stripFeatAndParen(title || rawQ));
    const cleanA = sanitizeLuceneTerm(artist);

    let luceneQuery = '';
    if (cleanT && cleanA) {
      luceneQuery = `recording:"${cleanT}" AND artist:"${cleanA}"`;
    } else if (cleanT) {
      luceneQuery = `recording:"${cleanT}"`;
    } else if (rawQ) {
      luceneQuery = sanitizeLuceneTerm(rawQ);
    }

    if (luceneQuery) {
      const mbUrl = new URL('https://musicbrainz.org/ws/2/recording');
      mbUrl.searchParams.set('query', luceneQuery);
      mbUrl.searchParams.set('fmt', 'json');
      mbUrl.searchParams.set('limit', '15');

      const response = await scheduleMusicBrainzFetch(mbUrl.toString());
      if (response.ok) {
        const data = await response.json();
        if (Array.isArray(data.recordings)) {
          recordings = data.recordings;
        }
      }
    }

    // 3. Fallback broader sanitized token query if strict phrase search returned 0
    if (recordings.length === 0 && (cleanT || rawQ)) {
      const broadQuery = sanitizeLuceneTerm([cleanA, cleanT || rawQ].filter(Boolean).join(' '));
      if (broadQuery) {
        const broadUrl = new URL('https://musicbrainz.org/ws/2/recording');
        broadUrl.searchParams.set('query', broadQuery);
        broadUrl.searchParams.set('fmt', 'json');
        broadUrl.searchParams.set('limit', '15');
        const broadRes = await scheduleMusicBrainzFetch(broadUrl.toString());
        if (broadRes.ok) {
          const broadData = await broadRes.json();
          if (Array.isArray(broadData.recordings)) {
            recordings = broadData.recordings;
          }
        }
      }
    }
  }

  // Rank recordings with studio-album priority and activeDurationSec support
  const rankedRecordings = [...recordings].sort(
    (a, b) =>
      scoreMusicBrainzRecording(
        b,
        params.durationSec,
        queryHint,
        params.activeDurationSec,
        canonicalAlbum
      ) -
      scoreMusicBrainzRecording(
        a,
        params.durationSec,
        queryHint,
        params.activeDurationSec,
        canonicalAlbum
      )
  );

  // Enrich the #1 recording with official genres, tags, and release-group metadata
  if (params.enrichTop && rankedRecordings[0]?.id) {
    try {
      const detailUrl = `https://musicbrainz.org/ws/2/recording/${rankedRecordings[0].id}?inc=artist-credits+releases+release-groups+tags+genres&fmt=json`;
      const detailRes = await scheduleMusicBrainzFetch(detailUrl);
      if (detailRes.ok) {
        const detailRec = (await detailRes.json()) as RawMusicBrainzRecording;
        rankedRecordings[0] = {
          ...rankedRecordings[0],
          ...detailRec,
          score: rankedRecordings[0].score,
        };
      }

      if (!extractBestMusicGenre(rankedRecordings[0].tags, rankedRecordings[0].genres)) {
        const topReleases = Array.isArray(rankedRecordings[0].releases)
          ? [...rankedRecordings[0].releases].sort(
              (a, b) =>
                scoreMusicBrainzRelease(b, queryHint, canonicalAlbum) -
                scoreMusicBrainzRelease(a, queryHint, canonicalAlbum)
            )
          : [];
        const rgId = topReleases[0]?.['release-group']?.id;
        if (rgId) {
          const rgRes = await scheduleMusicBrainzFetch(
            `https://musicbrainz.org/ws/2/release-group/${rgId}?inc=tags+genres&fmt=json`
          );
          if (rgRes.ok) {
            const rgData = (await rgRes.json()) as {
              tags?: Array<{name: string; count?: number}>;
              genres?: Array<{name: string; count?: number}>;
            };
            rankedRecordings[0] = {
              ...rankedRecordings[0],
              genres: [...(rankedRecordings[0].genres || []), ...(rgData.genres || [])],
              tags: [...(rankedRecordings[0].tags || []), ...(rgData.tags || [])],
            };
          }
        }
      }

      if (!extractBestMusicGenre(rankedRecordings[0].tags, rankedRecordings[0].genres)) {
        const artistId = rankedRecordings[0]['artist-credit']?.[0]?.artist?.id;
        if (artistId) {
          const artRes = await scheduleMusicBrainzFetch(
            `https://musicbrainz.org/ws/2/artist/${artistId}?inc=tags+genres&fmt=json`
          );
          if (artRes.ok) {
            const artData = (await artRes.json()) as {
              tags?: Array<{name: string; count?: number}>;
              genres?: Array<{name: string; count?: number}>;
            };
            rankedRecordings[0] = {
              ...rankedRecordings[0],
              genres: [...(rankedRecordings[0].genres || []), ...(artData.genres || [])],
              tags: [...(rankedRecordings[0].tags || []), ...(artData.tags || [])],
            };
          }
        }
      }
    } catch {
      // Non-fatal
    }
  }

  const formatted = rankedRecordings.slice(0, 12).map((rec, idx) => {
    const artistName = Array.isArray(rec['artist-credit'])
      ? rec['artist-credit']
          .map((ac) => `${ac.name || ac.artist?.name || ''}${ac.joinphrase || ''}`)
          .join('')
          .trim()
      : canonical?.artist || '';

    const sortedReleases = Array.isArray(rec.releases)
      ? [...rec.releases].sort(
          (a, b) =>
            scoreMusicBrainzRelease(b, queryHint, canonicalAlbum) -
            scoreMusicBrainzRelease(a, queryHint, canonicalAlbum)
        )
      : [];

    const releases = sortedReleases.map((rel) => ({
      id: rel.id,
      title: rel.title || '',
      date: rel.date || '',
      country: rel.country || '',
      status: rel.status || '',
      trackCount: rel['track-count'] || 0,
    }));

    const primaryRelease = releases[0];
    const yearMatch = (
      primaryRelease?.date ||
      rec['first-release-date'] ||
      (idx === 0 ? canonical?.year : '') ||
      ''
    ).match(/\d{4}/);
    const mbGenre = extractBestMusicGenre(rec.tags, rec.genres);
    const genre = mbGenre || (idx === 0 ? canonical?.genre || '' : '');

    return {
      mbid: rec.id,
      title: rec.title || canonical?.title || '',
      artist: artistName,
      album: primaryRelease?.title || (idx === 0 ? canonical?.album || '' : ''),
      releaseMbid: primaryRelease?.id || '',
      year: yearMatch ? yearMatch[0] : '',
      genre,
      durationMs: typeof rec.length === 'number' ? rec.length : null,
      score: typeof rec.score === 'number' ? rec.score : 0,
      releases: releases.slice(0, 5),
    };
  });

  // If MusicBrainz returned 0 recordings (or was unreachable) but canonical catalog resolved the song, synthesize a fallback entry
  if (formatted.length === 0 && canonical) {
    formatted.push({
      mbid: `catalog-${canonical.isrc || Date.now()}`,
      title: canonical.title,
      artist: canonical.artist,
      album: canonical.album || 'Single',
      releaseMbid: '',
      year: canonical.year || '2026',
      genre: canonical.genre || 'Rock',
      durationMs: canonical.durationSec ? canonical.durationSec * 1000 : null,
      score: 95,
      releases: [],
    });
  }

  return formatted;
}

function mapLrcItem(item: any) {
  return {
    id: item.id || Math.floor(Math.random() * 1000000),
    trackName: item.trackName || item.name || '',
    artistName: item.artistName || '',
    albumName: item.albumName && item.albumName !== 'null' ? item.albumName : '',
    duration: typeof item.duration === 'number' ? item.duration : 0,
    instrumental: Boolean(item.instrumental),
    hasSynced: Boolean(item.syncedLyrics),
    syncedLyrics: item.syncedLyrics || '',
    plainLyrics: item.plainLyrics || '',
  };
}

/**
 * Multi-stage Lyrics Resolver:
 * 1. Exact LRCLIB /api/get with canonical artist, title, album, duration
 * 2. LRCLIB /api/search?track_name=...&artist_name=...
 * 3. LRCLIB /api/search?q=... (stripped feat./video noise)
 * 4. Fallback to lyrics.ovh if LRCLIB has no match
 */
async function searchLyricsMultiStage(params: {
  title?: string;
  artist?: string;
  album?: string;
  q?: string;
  durationSec?: number;
  activeDurationSec?: number;
}) {
  let title = cleanMediaTitle(params.title || '');
  let artist = sanitizeArtistForQuery(params.artist || '');
  const rawQ = (params.q || '').trim();

  if (rawQ && (!title || !artist)) {
    const parsed = parseFilenameMetadata(rawQ);
    if (!title && parsed.title) title = parsed.title;
    if (!artist && parsed.artist) artist = parsed.artist;
  }

  const cleanT = stripFeatAndParen(title);
  const seenIds = new Set<number>();
  const collected: ReturnType<typeof mapLrcItem>[] = [];

  const pushUnique = (items: any[]) => {
    for (const raw of items) {
      if (!raw || (!raw.syncedLyrics && !raw.plainLyrics)) continue;
      const mapped = mapLrcItem(raw);
      if (!seenIds.has(mapped.id)) {
        seenIds.add(mapped.id);
        collected.push(mapped);
      }
    }
  };

  // Stage 1: Structured track_name + artist_name search on LRCLIB
  if (cleanT) {
    const u1 = new URL('https://lrclib.net/api/search');
    u1.searchParams.set('track_name', cleanT);
    if (artist) u1.searchParams.set('artist_name', artist);
    const r1 = await fetchJsonWithTimeout<any[]>(u1.toString(), 4000);
    if (Array.isArray(r1)) pushUnique(r1);
  }

  // Stage 2: Combined q search on LRCLIB (catches entries where artist is inside trackName or slightly different spelling)
  if (collected.filter((c) => c.hasSynced).length === 0) {
    const qStr = [artist, cleanT || rawQ].filter(Boolean).join(' ').trim();
    if (qStr) {
      const u2 = new URL('https://lrclib.net/api/search');
      u2.searchParams.set('q', qStr);
      const r2 = await fetchJsonWithTimeout<any[]>(u2.toString(), 4000);
      if (Array.isArray(r2)) pushUnique(r2);
    }
  }

  // Stage 3: Title-only search if artist spelling caused a miss
  if (collected.length === 0 && cleanT && artist) {
    const u3 = new URL('https://lrclib.net/api/search');
    u3.searchParams.set('q', cleanT);
    const r3 = await fetchJsonWithTimeout<any[]>(u3.toString(), 3500);
    if (Array.isArray(r3)) pushUnique(r3);
  }

  // Stage 4: Fallback to lyrics.ovh plain lyrics if LRCLIB had 0 matches
  if (collected.length === 0 && cleanT && artist) {
    const ovh = await fetchJsonWithTimeout<{lyrics?: string}>(
      `https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(cleanT)}`,
      3500
    );
    if (ovh?.lyrics && ovh.lyrics.trim().length > 20) {
      collected.push({
        id: 999999,
        trackName: cleanT,
        artistName: artist,
        albumName: params.album || '',
        duration: Math.round(params.activeDurationSec || params.durationSec || 180),
        instrumental: false,
        hasSynced: false,
        syncedLyrics: '',
        plainLyrics: ovh.lyrics.replace(/\r\n/g, '\n').trim(),
      });
    }
  }

  // Sort results so the highest-scoring synced lyrics for this studio track come first
  const best = pickBestLyricsResult(
    collected,
    params.durationSec,
    cleanT || title,
    params.activeDurationSec,
    artist,
    params.album
  );

  if (best) {
    return [best, ...collected.filter((c) => c.id !== best.id)].slice(0, 12);
  }
  return collected.slice(0, 12);
}

async function resolveCoverArtCascade(
  releaseIds: string[],
  fallbackCoverUrl?: string
): Promise<{dataUrl: string | null; mimeType: string | null}> {
  for (const rawId of releaseIds.slice(0, 3)) {
    const releaseId = (rawId || '').replace(/[^a-zA-Z0-9-]/g, '');
    if (!releaseId) continue;
    const res = await fetchImageAsDataUrl(
      `https://coverartarchive.org/release/${releaseId}/front-500`,
      3800
    );
    if (res.dataUrl) return res;
  }

  if (fallbackCoverUrl) {
    const fb = await fetchImageAsDataUrl(fallbackCoverUrl, 4000);
    if (fb.dataUrl) return fb;
  }

  return {dataUrl: null, mimeType: null};
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json({limit: '4mb'}));

  /**
   * Unified Audio-ID, Embedded Tag, MusicBrainz, Cover Art & Synced Lyrics Resolver.
   * Resolves songs reliably via ISRC / AcoustID / Embedded MBID / Multi-Catalog Disambiguation.
   */
  app.post('/api/audio-id/resolve', async (req, res) => {
    try {
      const body = req.body || {};
      const durationSec = Number(body.durationSec) || undefined;
      const activeDurationSec = Number(body.activeDurationSec) || durationSec;
      const embedded = body.embeddedTags || {};

      const seedTitle = cleanMediaTitle(embedded.title || body.title || '');
      const seedArtist = sanitizeArtistForQuery(embedded.artist || body.artist || '');
      const seedQuery = cleanMediaTitle(
        body.rawFileName ? body.rawFileName.replace(/\.[^/.]+$/, '') : [seedArtist, seedTitle].join(' ')
      );

      // Step 1: Resolve canonical track & ISRC Audio-ID via Deezer + iTunes + embedded ISRC
      const canonical = await resolveCanonicalCatalogTrack({
        artist: seedArtist,
        title: seedTitle,
        q: seedQuery,
        isrc: embedded.isrc,
        durationSec,
        activeDurationSec,
      });

      const resolvedTitle = canonical?.title || seedTitle;
      const resolvedArtist = canonical?.artist || seedArtist;
      const resolvedAlbum = canonical?.album || embedded.album || '';
      const resolvedIsrc = canonical?.isrc || embedded.isrc || '';

      // Step 2: Run MusicBrainz studio recording search & multi-stage LRCLIB search in parallel
      const [mbResults, lrcResults] = await Promise.all([
        searchAndRankMusicBrainz({
          title: resolvedTitle,
          artist: resolvedArtist,
          q: seedQuery,
          isrc: resolvedIsrc,
          mbid: embedded.mbid,
          durationSec,
          activeDurationSec,
          enrichTop: true,
          canonicalHint: canonical,
        }),
        searchLyricsMultiStage({
          title: resolvedTitle,
          artist: resolvedArtist,
          album: resolvedAlbum,
          q: seedQuery,
          durationSec,
          activeDurationSec,
        }),
      ]);

      const bestMb = mbResults[0] || null;
      const releaseCandidateIds = bestMb
        ? Array.from(
            new Set(
              [bestMb.releaseMbid, ...bestMb.releases.map((r) => r.id)].filter((id): id is string =>
                Boolean(id)
              )
            )
          )
        : [];

      // Step 3: Resolve official Cover Art (Cover Art Archive -> Deezer/iTunes 600x600 studio cover)
      const cover = await resolveCoverArtCascade(releaseCandidateIds, canonical?.coverUrl);

      res.json({
        audioId: body.audioId || null,
        isrc: resolvedIsrc || null,
        catalogBpm: canonical?.bpm || null,
        identificationSource:
          embedded.mbid
            ? 'Embedded MBID'
            : resolvedIsrc
              ? `Audio-ID / ISRC (${resolvedIsrc})`
              : canonical
                ? 'Multi-Catalog Audio-ID'
                : 'MusicBrainz Match',
        canonical: canonical || null,
        mbResults,
        lrcResults,
        coverDataUrl: cover.dataUrl,
        coverMime: cover.mimeType,
      });
    } catch (error) {
      console.error('Audio-ID resolve error:', error);
      res.status(502).json({error: 'Automatische Audio-ID-Auflösung fehlgeschlagen.'});
    }
  });

  // MusicBrainz Recording Search Proxy (with canonical catalog disambiguation & Lucene sanitizer)
  app.get('/api/musicbrainz/search', async (req, res) => {
    try {
      const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
      const title = typeof req.query.title === 'string' ? req.query.title.trim() : '';
      const artist = typeof req.query.artist === 'string' ? req.query.artist.trim() : '';
      const durationSec = Number(req.query.durationSec) || undefined;
      const activeDurationSec = Number(req.query.activeDurationSec) || durationSec;
      const enrichTop = req.query.enrich === '1';

      if (!q && !title && !artist) {
        res.status(400).json({error: 'Suchbegriff erforderlich.'});
        return;
      }

      const canonical = await resolveCanonicalCatalogTrack({
        artist,
        title,
        q,
        durationSec,
        activeDurationSec,
      });

      const formatted = await searchAndRankMusicBrainz({
        q,
        title,
        artist,
        durationSec,
        activeDurationSec,
        enrichTop,
        canonicalHint: canonical,
      });

      res.json({
        results: formatted,
        isrc: canonical?.isrc || null,
        fallbackCoverUrl: canonical?.coverUrl || null,
      });
    } catch (error) {
      console.error('MusicBrainz search error:', error);
      res.status(502).json({error: 'Verbindung zu MusicBrainz fehlgeschlagen.'});
    }
  });

  // Cover Art Archive Proxy with fallback URL support
  app.get('/api/musicbrainz/cover/:releaseId', async (req, res) => {
    try {
      const releaseId = (req.params.releaseId || '').replace(/[^a-zA-Z0-9-]/g, '');
      const fallbackUrl =
        typeof req.query.fallbackUrl === 'string' ? req.query.fallbackUrl.trim() : '';

      const urls = releaseId
        ? [
            `https://coverartarchive.org/release/${releaseId}/front-500`,
            `https://coverartarchive.org/release/${releaseId}/front`,
          ]
        : [];
      if (fallbackUrl) urls.push(fallbackUrl);

      for (const coverUrl of urls) {
        const img = await fetchImageAsDataUrl(coverUrl, 4500);
        if (img.dataUrl) {
          res.json(img);
          return;
        }
      }

      res.json({dataUrl: null, mimeType: null});
    } catch (error) {
      console.error('Cover Art Archive error:', error);
      res.status(502).json({error: 'Cover-Download fehlgeschlagen.'});
    }
  });

  // LRCLIB Multi-Stage Lyrics Search Proxy
  app.get('/api/lyrics/search', async (req, res) => {
    try {
      const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
      const trackName = typeof req.query.track_name === 'string' ? req.query.track_name.trim() : '';
      const artistName =
        typeof req.query.artist_name === 'string' ? req.query.artist_name.trim() : '';
      const durationSec = Number(req.query.durationSec) || undefined;
      const activeDurationSec = Number(req.query.activeDurationSec) || durationSec;

      if (!q && !trackName) {
        res.status(400).json({error: 'Titel oder Suchbegriff erforderlich.'});
        return;
      }

      // If artist is missing or combined inside q, disambiguate via catalog first
      let resolvedTitle = trackName;
      let resolvedArtist = sanitizeArtistForQuery(artistName);
      let resolvedAlbum = '';

      if (!resolvedArtist || !resolvedTitle) {
        const canonical = await resolveCanonicalCatalogTrack({
          artist: resolvedArtist,
          title: resolvedTitle,
          q: q || [resolvedArtist, resolvedTitle].filter(Boolean).join(' '),
          durationSec,
          activeDurationSec,
        });
        if (canonical) {
          resolvedTitle = resolvedTitle || canonical.title;
          resolvedArtist = resolvedArtist || canonical.artist;
          resolvedAlbum = canonical.album;
        }
      }

      const results = await searchLyricsMultiStage({
        title: resolvedTitle,
        artist: resolvedArtist,
        album: resolvedAlbum,
        q,
        durationSec,
        activeDurationSec,
      });

      res.json({results});
    } catch (error) {
      console.error('LRCLIB search error:', error);
      res.status(502).json({error: 'Verbindung zu LRCLIB fehlgeschlagen.'});
    }
  });

  app.get('/api/lyrics/get', async (req, res) => {
    try {
      const trackName = typeof req.query.track_name === 'string' ? req.query.track_name.trim() : '';
      const artistName =
        typeof req.query.artist_name === 'string' ? req.query.artist_name.trim() : '';
      const albumName = typeof req.query.album_name === 'string' ? req.query.album_name.trim() : '';
      const duration = typeof req.query.duration === 'string' ? req.query.duration.trim() : '';

      if (!trackName || !artistName) {
        res.status(400).json({error: 'track_name und artist_name sind erforderlich.'});
        return;
      }

      const lrcUrl = new URL('https://lrclib.net/api/get');
      lrcUrl.searchParams.set('track_name', trackName);
      lrcUrl.searchParams.set('artist_name', artistName);
      if (albumName) lrcUrl.searchParams.set('album_name', albumName);
      if (duration) lrcUrl.searchParams.set('duration', duration);

      const item = await fetchJsonWithTimeout<any>(lrcUrl.toString(), 4000);
      if (!item) {
        res.status(404).json({error: 'Keine exakten Lyrics gefunden.'});
        return;
      }

      res.json({result: mapLrcItem(item)});
    } catch (error) {
      console.error('LRCLIB get error:', error);
      res.status(502).json({error: 'Verbindung zu LRCLIB fehlgeschlagen.'});
    }
  });

  // Vite dev middleware vs static production serving
  const isProd =
    process.env.NODE_ENV === 'production' && fs.existsSync(path.join(__dirname, 'dist'));
  if (!isProd) {
    const vite = await createViteServer({
      server: {middlewareMode: true},
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.join(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`CloneForge Studio server running on http://localhost:${PORT}`);
  });
}

startServer();
