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
    url.searchParams.set('maxResults', '3'); // top 3, matches your UI text
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
  const filePath = path.join(CACHE_DIR, `${trackId}.webm`);

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

    const dlProc = spawn('yt-dlp', [
      '-f',
      'bestaudio',
      '-o',
      filePath,
      url,
    ]);

    dlProc.stderr.on('data', (data) => {
      console.error('yt-dlp (download):', data.toString());
    });

    dlProc.on('close', (dlCode) => {
      if (dlCode !== 0) {
        console.error('yt-dlp download failed with code', dlCode);
        if (fs.existsSync(filePath)) {
          fs.unlink(filePath, () => {});
        }
        return res.status(500).json({ error: 'Failed to download audio.' });
      }

      // Register track in memory
      tracks[trackId] = {
        filePath,
        duration,
        createdAt: Date.now(),
      };

      console.log('Track prepared:', trackId, 'duration:', duration);

      res.json({
        trackId,
        duration, // may be 0 if unknown
      });
    });
  });
});

// /audio: stream from cached file with optional ?start=SECONDS as MP3
app.get('/audio', (req, res) => {
  const trackId = req.query.trackId;
  const start = parseFloat(req.query.start || '0') || 0;

  if (!trackId || !tracks[trackId]) {
    return res.status(404).json({ error: 'Unknown or expired trackId.' });
  }

  const { filePath } = tracks[trackId];

  console.log('Streaming audio from cache:', trackId, 'start:', start);

  const ffArgs = [];

  if (start > 0) {
    ffArgs.push('-ss', String(start));
  }

  // Encode to MP3 for maximum compatibility (desktop + mobile)
  ffArgs.push(
    '-i',
    filePath,
    '-vn',
    '-f',
    'mp3',
    '-acodec',
    'libmp3lame',
    '-b:a',
    '192k',
    'pipe:1'
  );

  const ff = spawn('ffmpeg', ffArgs);

  let headersSent = false;

  res.on('error', (err) => {
    if (err && err.code === 'EPIPE') {
      console.warn('Client disconnected (EPIPE) during /audio stream');
    } else {
      console.error('Response error:', err);
    }
  });

  ff.stdout.on('data', (chunk) => {
    if (res.destroyed || res.writableEnded) {
      return; // client is gone
    }

    if (!headersSent) {
      headersSent = true;
      res.setHeader('Content-Type', 'audio/mpeg');
    }

    try {
      res.write(chunk);
    } catch (err) {
      if (err.code === 'EPIPE') {
        console.warn('EPIPE while writing audio to client.');
      } else {
        console.error('Error writing audio chunk:', err);
      }
    }
  });

  ff.stderr.on('data', (data) => {
    console.error('ffmpeg:', data.toString());
  });

  ff.on('error', (err) => {
    console.error('Failed to start ffmpeg:', err);
    if (!headersSent && !res.headersSent) {
      res.status(500).json({ error: 'Failed to start ffmpeg.' });
    } else {
      res.destroy(err);
    }
  });

  ff.on('close', (code) => {
    console.log('ffmpeg exited with code', code);
    if (!headersSent) {
      if (!res.headersSent) {
        if (code === 0) {
          res.end();
        } else {
          res.status(500).json({ error: 'Failed to process audio.' });
        }
      }
    } else {
      if (!res.writableEnded) {
        res.end();
      }
    }
  });
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