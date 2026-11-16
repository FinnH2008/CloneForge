import express from 'express';
import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';
import {createServer as createViteServer} from 'vite';
import {
  extractBestMusicGenre,
  scoreMusicBrainzRecording,
  scoreMusicBrainzRelease,
  type RawMusicBrainzRecording,
} from './src/utils/autoSelect';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const APP_USER_AGENT = 'CloneForgeStudio/1.0.0 (https://cloneforge.studio; contact@cloneforge.studio)';

// MusicBrainz strict rate limiter: max 1 request per 1100ms
let lastMusicBrainzRequest = 0;
let mbQueue: Promise<unknown> = Promise.resolve();

function scheduleMusicBrainzFetch(url: string): Promise<Response> {
  const run = async () => {
    let lastResponse: Response | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const now = Date.now();
      const waitMs = Math.max(0, lastMusicBrainzRequest + 1150 - now);
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
      await new Promise((resolve) => setTimeout(resolve, 1200 * (attempt + 1)));
    }
    return lastResponse!;
  };
  const next = mbQueue.then(run, run);
  mbQueue = next.catch(() => {});
  return next;
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json({limit: '2mb'}));

  // MusicBrainz Recording Search Proxy (ranked for studio albums & accurate genres)
  app.get('/api/musicbrainz/search', async (req, res) => {
    try {
      const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
      const title = typeof req.query.title === 'string' ? req.query.title.trim() : '';
      const artist = typeof req.query.artist === 'string' ? req.query.artist.trim() : '';
      const durationSec = Number(req.query.durationSec) || undefined;
      const enrichTop = req.query.enrich === '1';

      let luceneQuery = '';
      if (title && artist) {
        luceneQuery = `recording:"${title.replace(/"/g, '')}" AND artist:"${artist.replace(/"/g, '')}"`;
      } else if (title) {
        luceneQuery = `recording:"${title.replace(/"/g, '')}"`;
      } else if (q) {
        luceneQuery = q;
      }

      if (!luceneQuery) {
        res.status(400).json({error: 'Suchbegriff erforderlich.'});
        return;
      }

      const queryHint = [artist, title, q].filter(Boolean).join(' ');
      const mbUrl = new URL('https://musicbrainz.org/ws/2/recording');
      mbUrl.searchParams.set('query', luceneQuery);
      mbUrl.searchParams.set('fmt', 'json');
      mbUrl.searchParams.set('limit', '15');

      const response = await scheduleMusicBrainzFetch(mbUrl.toString());
      if (!response.ok) {
        res.status(response.status).json({
          error: `MusicBrainz-Antwort fehlgeschlagen (${response.status}).`,
        });
        return;
      }

      const data = await response.json();
      let recordings: RawMusicBrainzRecording[] = Array.isArray(data.recordings)
        ? data.recordings
        : [];

      // Fallback broader query if strict AND query returned empty
      if (recordings.length === 0 && title && artist) {
        const broadUrl = new URL('https://musicbrainz.org/ws/2/recording');
        broadUrl.searchParams.set('query', `${artist} ${title}`);
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

      // Rank recordings (studio originals above compilations & music videos)
      const rankedRecordings = [...recordings].sort(
        (a, b) =>
          scoreMusicBrainzRecording(b, durationSec, queryHint) -
          scoreMusicBrainzRecording(a, durationSec, queryHint)
      );

      // Enrich the #1 recording with official genres, tags, and cover-art-archive flags
      if (enrichTop && rankedRecordings[0]?.id) {
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

          // Fallback: if recording only had non-musical tags (e.g. "music video") or none, check best release-group then artist
          if (!extractBestMusicGenre(rankedRecordings[0].tags, rankedRecordings[0].genres)) {
            const topReleases = Array.isArray(rankedRecordings[0].releases)
              ? [...rankedRecordings[0].releases].sort(
                  (a, b) =>
                    scoreMusicBrainzRelease(b, queryHint) - scoreMusicBrainzRelease(a, queryHint)
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
                if ((rgData.genres?.length || 0) > 0 || (rgData.tags?.length || 0) > 0) {
                  rankedRecordings[0] = {
                    ...rankedRecordings[0],
                    genres: [...(rankedRecordings[0].genres || []), ...(rgData.genres || [])],
                    tags: [...(rankedRecordings[0].tags || []), ...(rgData.tags || [])],
                  };
                }
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
          // Non-fatal: keep search payload
        }
      }

      const formatted = rankedRecordings.slice(0, 12).map((rec) => {
        const artistName = Array.isArray(rec['artist-credit'])
          ? rec['artist-credit']
              .map((ac) => `${ac.name || ac.artist?.name || ''}${ac.joinphrase || ''}`)
              .join('')
              .trim()
          : '';

        const sortedReleases = Array.isArray(rec.releases)
          ? [...rec.releases].sort(
              (a, b) =>
                scoreMusicBrainzRelease(b, queryHint) - scoreMusicBrainzRelease(a, queryHint)
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
        const yearMatch = (primaryRelease?.date || rec['first-release-date'] || '').match(/\d{4}/);
        const genre = extractBestMusicGenre(rec.tags, rec.genres);

        return {
          mbid: rec.id,
          title: rec.title || '',
          artist: artistName,
          album: primaryRelease?.title || '',
          releaseMbid: primaryRelease?.id || '',
          year: yearMatch ? yearMatch[0] : '',
          genre,
          durationMs: typeof rec.length === 'number' ? rec.length : null,
          score: typeof rec.score === 'number' ? rec.score : 0,
          releases: releases.slice(0, 5),
        };
      });

      res.json({results: formatted});
    } catch (error) {
      console.error('MusicBrainz search error:', error);
      res.status(502).json({error: 'Verbindung zu MusicBrainz fehlgeschlagen.'});
    }
  });

  // Cover Art Archive Proxy
  app.get('/api/musicbrainz/cover/:releaseId', async (req, res) => {
    try {
      const releaseId = (req.params.releaseId || '').replace(/[^a-zA-Z0-9-]/g, '');
      if (!releaseId) {
        res.status(400).json({error: 'Ungültige Release-ID.'});
        return;
      }

      const urls = [
        `https://coverartarchive.org/release/${releaseId}/front-500`,
        `https://coverartarchive.org/release/${releaseId}/front`,
      ];

      for (const coverUrl of urls) {
        const response = await fetch(coverUrl, {
          headers: {'User-Agent': APP_USER_AGENT},
          redirect: 'follow',
        });
        if (response.ok) {
          const contentType = response.headers.get('content-type') || 'image/jpeg';
          const arrayBuffer = await response.arrayBuffer();
          const base64 = Buffer.from(arrayBuffer).toString('base64');
          res.json({
            dataUrl: `data:${contentType};base64,${base64}`,
            mimeType: contentType,
          });
          return;
        }
      }

      res.json({dataUrl: null, mimeType: null});
    } catch (error) {
      console.error('Cover Art Archive error:', error);
      res.status(502).json({error: 'Cover-Download fehlgeschlagen.'});
    }
  });

  // LRCLIB Lyrics Search & Exact Get Proxy
  app.get('/api/lyrics/search', async (req, res) => {
    try {
      const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
      const trackName = typeof req.query.track_name === 'string' ? req.query.track_name.trim() : '';
      const artistName = typeof req.query.artist_name === 'string' ? req.query.artist_name.trim() : '';

      if (!q && !trackName) {
        res.status(400).json({error: 'Titel oder Suchbegriff erforderlich.'});
        return;
      }

      const lrcUrl = new URL('https://lrclib.net/api/search');
      if (trackName) {
        lrcUrl.searchParams.set('track_name', trackName);
        if (artistName) lrcUrl.searchParams.set('artist_name', artistName);
      } else {
        lrcUrl.searchParams.set('q', q);
      }

      const response = await fetch(lrcUrl.toString(), {
        headers: {
          'User-Agent': APP_USER_AGENT,
          Accept: 'application/json',
        },
      });

      if (!response.ok) {
        res.status(response.status).json({error: `LRCLIB-Antwort fehlgeschlagen (${response.status}).`});
        return;
      }

      const items = await response.json();
      const results = Array.isArray(items)
        ? items.slice(0, 12).map((item: any) => ({
            id: item.id,
            trackName: item.trackName || '',
            artistName: item.artistName || '',
            albumName: item.albumName || '',
            duration: typeof item.duration === 'number' ? item.duration : 0,
            instrumental: Boolean(item.instrumental),
            hasSynced: Boolean(item.syncedLyrics),
            syncedLyrics: item.syncedLyrics || '',
            plainLyrics: item.plainLyrics || '',
          }))
        : [];

      res.json({results});
    } catch (error) {
      console.error('LRCLIB search error:', error);
      res.status(502).json({error: 'Verbindung zu LRCLIB fehlgeschlagen.'});
    }
  });

  app.get('/api/lyrics/get', async (req, res) => {
    try {
      const trackName = typeof req.query.track_name === 'string' ? req.query.track_name.trim() : '';
      const artistName = typeof req.query.artist_name === 'string' ? req.query.artist_name.trim() : '';
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

      const response = await fetch(lrcUrl.toString(), {
        headers: {
          'User-Agent': APP_USER_AGENT,
          Accept: 'application/json',
        },
      });

      if (response.status === 404) {
        res.status(404).json({error: 'Keine exakten Lyrics gefunden.'});
        return;
      }

      if (!response.ok) {
        res.status(response.status).json({error: `LRCLIB-Fehler (${response.status}).`});
        return;
      }

      const item = await response.json();
      res.json({
        result: {
          id: item.id,
          trackName: item.trackName || '',
          artistName: item.artistName || '',
          albumName: item.albumName || '',
          duration: typeof item.duration === 'number' ? item.duration : 0,
          instrumental: Boolean(item.instrumental),
          hasSynced: Boolean(item.syncedLyrics),
          syncedLyrics: item.syncedLyrics || '',
          plainLyrics: item.plainLyrics || '',
        },
      });
    } catch (error) {
      console.error('LRCLIB get error:', error);
      res.status(502).json({error: 'Verbindung zu LRCLIB fehlgeschlagen.'});
    }
  });

  // Vite dev middleware vs static production serving
  const isProd = process.env.NODE_ENV === 'production' && fs.existsSync(path.join(__dirname, 'dist'));
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
