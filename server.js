// server.js - keyshift-prototype with local caching + fast seek + MP3 streaming

// --- Global error handling to avoid crashes from broken pipes (EPIPE) ---
process.on('uncaughtException', (err) => {
  if (err && err.code === 'EPIPE') {
    console.warn('Global EPIPE ignored (client disconnected).');
    return;
  }
  console.error('Uncaught exception:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});

// --- Imports ---
const express = require('express');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const pkg = require('./package.json');

const YT_SEARCH_ENDPOINT = 'https://www.googleapis.com/youtube/v3/search';

// --- App setup ---
const app = express();
const PORT = process.env.PORT || 3000;

// --- Cache for downloaded audio files ---

// Cache directory in the system temp folder
const CACHE_DIR = path.join(os.tmpdir(), 'keyshift-prototype-cache');

// Ensure cache directory exists
if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

// In-memory track registry: trackId -> { filePath, duration, createdAt }
const tracks = Object.create(null);

// Generate a random track ID
function createTrackId() {
  return crypto.randomBytes(8).toString('hex');
}

// Basic YouTube URL validation
function isYouTubeUrl(url) {
  try {
    const u = new URL(url);
    return (
      u.hostname === 'www.youtube.com' ||
      u.hostname === 'youtube.com' ||
      u.hostname === 'youtu.be'
    );
  } catch {
    return false;
  }
}

// Use ffprobe to get the actual duration (in seconds) of a downloaded file
function probeDurationSeconds(filePath) {
  return new Promise((resolve) => {
    const proc = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath,
    ]);

    let out = '';
    proc.stdout.on('data', (data) => {
      out += data.toString();
    });

    proc.on('error', (err) => {
      console.error('ffprobe error:', err);
      resolve(0);
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        console.warn('ffprobe exited with code', code);
        return resolve(0);
      }
      const raw = out.trim();
      const seconds = parseFloat(raw);
      if (!Number.isFinite(seconds) || seconds <= 0) {
        resolve(0);
      } else {
        resolve(seconds);
      }
    });
  });
}

// --- Middleware / static files ---
app.use(express.static(path.join(__dirname, 'public')));

// --- Routes ---

// Homepage
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Version info from package.json
app.get('/version', (req, res) => {
  res.json({ version: pkg.version || '1.0.0' });
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// --- Search cache (for yt-dlp ytsearch3) ---
const searchCache = Object.create(null);
const SEARCH_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// /search: search YouTube for songs using yt-dlp's ytsearch3
app.get('/api/search', async (req, res) => {
  const rawQuery = (req.query.q || '').trim();
  if (!rawQuery) {
    return res.status(400).json({ error: 'Missing search query.' });
  }

  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    console.error('YOUTUBE_API_KEY is not set on the server.');
    return res.status(500).json({ error: 'Search is not configured on this server.' });
  }

  try {
    const url = new URL(YT_SEARCH_ENDPOINT);
    url.searchParams.set('key', apiKey);
    url.searchParams.set('part', 'snippet');
    url.searchParams.set('type', 'video');
    url.searchParams.set('maxResults', '10');
    url.searchParams.set('q', rawQuery);

    console.log('YouTube API search:', rawQuery);
    const response = await fetch(url);
    if (!response.ok) {
      const text = await response.text();
      console.error('YouTube API error:', response.status, text);
      return res.status(502).json({ error: 'YouTube search failed.' });
    }

    const data = await response.json();
    const items = (data.items || []).map(item => {
      const id = item.id && item.id.videoId;
      const snippet = item.snippet || {};
      const title = snippet.title || 'Untitled';
      const channel = snippet.channelTitle || 'Unknown channel';
      const thumbnail =
        (snippet.thumbnails && snippet.thumbnails.default && snippet.thumbnails.default.url) ||
        null;

      return {
        id,
        title,
        channel,
        url: id ? `https://www.youtube.com/watch?v=${id}` : null,
        thumbnail
      };
    }).filter(r => r.url);

    res.json({ results: items });
  } catch (err) {
    console.error('Server search error (YouTube API):', err);
    res.status(500).json({ error: 'Search failed.' });
  }
});

// /prepare: download audio once, store it, return trackId + duration
app.get('/prepare', (req, res) => {
  const url = req.query.url;

  if (!url || !isYouTubeUrl(url)) {
    return res.status(400).json({ error: 'Invalid or missing YouTube URL.' });
  }

  console.log('Preparing track for:', url);

  const trackId = createTrackId();
  const filePath = path.join(CACHE_DIR, `${trackId}.mp3`);

  // Step 1: get info (duration) via yt-dlp -J
  const infoProc = spawn('yt-dlp', ['-J', url]);

  let infoStdout = '';
  let infoStderr = '';

  infoProc.stdout.on('data', (data) => {
    infoStdout += data.toString();
  });

  infoProc.stderr.on('data', (data) => {
    infoStderr += data.toString();
  });

  infoProc.on('close', (code) => {
    let duration = 0;

    if (code !== 0) {
      console.warn('yt-dlp info error:', infoStderr);
    } else {
      try {
        const info = JSON.parse(infoStdout);
        if (typeof info.duration === 'number') {
          duration = info.duration;
        }
      } catch (err) {
        console.warn('Failed to parse yt-dlp JSON:', err);
      }
    }

    // Step 2: download bestaudio to a local file
    console.log('Downloading audio to cache:', filePath);

    // Step 2: download & convert to MP3 once, into our cache
console.log('Downloading audio (MP3) to cache:', filePath);

const dlProc = spawn('yt-dlp', [
  '--extractor-args', 'youtube:player_client=default',
  '--cookies', 'cookies.txt',

  '--js-runtimes', 'node',
  '--remote-components', 'ejs:github',

  '-N', '1',
  '--no-playlist',

  // Extract audio and convert to MP3 using yt-dlp + ffmpeg
  '--extract-audio',
  '--audio-format', 'mp3',
  '--audio-quality', '5',          // smaller file, still good for practice

  '-o', filePath,
  url,
]);

    dlProc.stderr.on('data', (data) => {
      console.error('yt-dlp (download):', data.toString());
    });

        dlProc.on('close', async (dlCode) => {
      if (dlCode !== 0) {
        console.error('yt-dlp download failed with code', dlCode);
        if (fs.existsSync(filePath)) {
          fs.unlink(filePath, () => {});
        }
        return res.status(500).json({ error: 'Failed to download audio.' });
      }

      try {
        // First try ffprobe on the downloaded file
        const probed = await probeDurationSeconds(filePath);
        const finalDuration = (Number.isFinite(probed) && probed > 0)
          ? probed
          : duration; // fall back to yt-dlp JSON duration if ffprobe fails

        // Register track in memory
        tracks[trackId] = {
          filePath,
          duration: finalDuration,
          createdAt: Date.now(),
        };

        console.log('Track prepared:', trackId, 'duration:', finalDuration);

        return res.json({
          trackId,
          duration: finalDuration,
        });
      } catch (err) {
        console.error('Error probing duration:', err);

        // At least register the track with whatever duration we had (possibly 0)
        tracks[trackId] = {
          filePath,
          duration,
          createdAt: Date.now(),
        };

        return res.json({
          trackId,
          duration,
        });
      }
    });
  });
});

// /audio: stream cached MP3 file, with HTTP Range support for fast seeking
app.get('/audio', (req, res) => {
  const trackId = req.query.trackId;

  if (!trackId || !tracks[trackId]) {
    return res.status(404).json({ error: 'Unknown or expired trackId.' });
  }

  const { filePath } = tracks[trackId];

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Cached audio file not found.' });
  }

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;

  // If client requested a byte range (most modern browsers do)
  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

    if (Number.isNaN(start) || Number.isNaN(end) || start > end) {
      return res.status(416).end();
    }

    const chunkSize = end - start + 1;
    const fileStream = fs.createReadStream(filePath, { start, end });

    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': 'audio/mpeg',
    });

    fileStream.on('error', (err) => {
      console.error('Error streaming audio file:', err);
      if (!res.headersSent) {
        res.status(500).end();
      } else {
        res.destroy(err);
      }
    });

    fileStream.pipe(res);
  } else {
    // No Range header: send entire file
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': 'audio/mpeg',
    });

    const fileStream = fs.createReadStream(filePath);
    fileStream.on('error', (err) => {
      console.error('Error streaming full audio file:', err);
      if (!res.headersSent) {
        res.status(500).end();
      } else {
        res.destroy(err);
      }
    });

    fileStream.pipe(res);
  }
});

// --- Simple cache cleanup: delete tracks older than 1 hour ---
const CACHE_TTL_MS = 60 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const trackId of Object.keys(tracks)) {
    const track = tracks[trackId];
    if (now - track.createdAt > CACHE_TTL_MS) {
      console.log('Cleaning up track:', trackId);
      try {
        if (fs.existsSync(track.filePath)) {
          fs.unlinkSync(track.filePath);
        }
      } catch (err) {
        console.warn('Failed to delete cached file:', err);
      }
      delete tracks[trackId];
    }
  }
}, 10 * 60 * 1000); // run every 10 minutes

// --- Start server ---
app.listen(PORT, () => {
  console.log(`keyshift-prototype server running at http://localhost:${PORT}`);
});