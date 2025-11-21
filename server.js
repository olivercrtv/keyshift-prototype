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

// ---------- Simple DSP-based key detection ----------

// Pitch classes we’ll use (in semitone order)
const PITCH_CLASS_NAMES = [
  'C', 'C#', 'D', 'D#', 'E', 'F',
  'F#', 'G', 'G#', 'A', 'A#', 'B'
];

// Krumhansl-Schmuckler key profiles (classic music-psychology values)
const KRUMHANSL_MAJOR = [
  6.35, 2.23, 3.48, 2.33, 4.38, 4.09,
  2.52, 5.19, 2.39, 3.66, 2.29, 2.88
];

const KRUMHANSL_MINOR = [
  6.33, 2.68, 3.52, 5.38, 2.60, 3.53,
  2.54, 4.75, 3.98, 2.69, 3.34, 3.17
];

/**
 * Run ffmpeg to extract a mono, downsampled PCM stream from the MP3,
 * then analyze pitch-class energy to estimate the key.
 *
 * Returns:
 *   { tonicIndex, tonicName, mode, confidence, score }
 * or null if detection fails.
 */
async function detectKeyForFile(filePath) {
  return new Promise((resolve) => {
    const sampleRate = 11025;
    const analyzeSeconds = 60; // only look at first 60s to keep it fast

    const ff = spawn('ffmpeg', [
      '-i', filePath,
      '-vn',
      '-ac', '1',
      '-ar', String(sampleRate),
      '-f', 's16le',
      '-t', String(analyzeSeconds),
      'pipe:1',
    ]);

    const chunks = [];
    ff.stdout.on('data', (chunk) => {
      chunks.push(chunk);
    });

    ff.on('error', (err) => {
      console.error('ffmpeg error during key detection:', err);
      resolve(null);
    });

    ff.on('close', (code) => {
      if (code !== 0 || chunks.length === 0) {
        console.warn('ffmpeg key-detection exited with code', code);
        return resolve(null);
      }

      try {
        const buffer = Buffer.concat(chunks);
        const sampleCount = buffer.length / 2;
        if (!Number.isFinite(sampleCount) || sampleCount <= 0) {
          return resolve(null);
        }

        // Convert 16-bit PCM to float [-1, 1]
        const samples = new Float32Array(sampleCount);
        for (let i = 0; i < sampleCount; i++) {
          const s = buffer.readInt16LE(i * 2);
          samples[i] = s / 32768;
        }

        const result = analyzeKeyFromSamples(samples, sampleRate);
        resolve(result);
      } catch (err) {
        console.error('Error in key detection processing:', err);
        resolve(null);
      }
    });
  });
}

/**
 * Analyze pitch-class (chroma-like) energy from time-domain samples
 * using a simple Goertzel-based approach on multiple octaves.
 */
function analyzeKeyFromSamples(samples, sampleRate) {
  const frameSize = 2048;
  const hopSize = 1024;

  if (samples.length < frameSize) {
    return null;
  }

  // Precompute a Hann window
  const hann = new Float32Array(frameSize);
  for (let n = 0; n < frameSize; n++) {
    hann[n] = 0.5 * (1 - Math.cos((2 * Math.PI * n) / (frameSize - 1)));
  }

  // Build a list of frequencies (3 octaves) and map each to a pitch class
  // Use MIDI 48 (C3) to 83 (B5) as a mid-range band.
  const freqTargets = [];
  for (let midi = 48; midi <= 83; midi++) {
    const freq = 440 * Math.pow(2, (midi - 69) / 12);
    const pc = midi % 12;
    const omega = (2 * Math.PI * freq) / sampleRate;
    const coeff = 2 * Math.cos(omega);
    freqTargets.push({ freq, pc, coeff });
  }

  // Chroma energy (12 bins)
  const chroma = new Float32Array(12);

  // Frame loop
  for (let start = 0; start + frameSize <= samples.length; start += hopSize) {
    // For each target frequency, run Goertzel on this frame
    for (let t = 0; t < freqTargets.length; t++) {
      const { pc, coeff } = freqTargets[t];
      let s_prev = 0;
      let s_prev2 = 0;

      for (let n = 0; n < frameSize; n++) {
        const x = samples[start + n] * hann[n];
        const s = x + coeff * s_prev - s_prev2;
        s_prev2 = s_prev;
        s_prev = s;
      }

      const power =
        s_prev2 * s_prev2 +
        s_prev * s_prev -
        coeff * s_prev * s_prev2;

      if (power > 0) {
        chroma[pc] += power;
      }
    }
  }

  // Normalize chroma
  let chromaSum = 0;
  for (let i = 0; i < 12; i++) chromaSum += chroma[i];
  if (chromaSum === 0) {
    return null;
  }
  for (let i = 0; i < 12; i++) chroma[i] /= chromaSum;

  // Helper: compute cosine similarity
  function cosineSimilarity(a, b) {
    let dot = 0;
    let magA = 0;
    let magB = 0;
    for (let i = 0; i < a.length; i++) {
      const x = a[i];
      const y = b[i];
      dot += x * y;
      magA += x * x;
      magB += y * y;
    }
    if (magA === 0 || magB === 0) return 0;
    return dot / Math.sqrt(magA * magB);
  }

  let bestScore = -Infinity;
  let secondBestScore = -Infinity;
  let bestTonic = 0;
  let bestMode = 'major';

  // Try all 24 keys (12 major, 12 minor)
  for (let tonic = 0; tonic < 12; tonic++) {
    // Build rotated major profile for this tonic
    const majorProfile = new Float32Array(12);
    const minorProfile = new Float32Array(12);
    for (let i = 0; i < 12; i++) {
      majorProfile[i] = KRUMHANSL_MAJOR[(i - tonic + 12) % 12];
      minorProfile[i] = KRUMHANSL_MINOR[(i - tonic + 12) % 12];
    }

    const majorScore = cosineSimilarity(chroma, majorProfile);
    const minorScore = cosineSimilarity(chroma, minorProfile);

    const candidates = [
      { score: majorScore, mode: 'major', tonic },
      { score: minorScore, mode: 'minor', tonic },
    ];

    for (const c of candidates) {
      if (c.score > bestScore) {
        secondBestScore = bestScore;
        bestScore = c.score;
        bestTonic = c.tonic;
        bestMode = c.mode;
      } else if (c.score > secondBestScore) {
        secondBestScore = c.score;
      }
    }
  }

  if (!Number.isFinite(bestScore) || bestScore <= 0) {
    return null;
  }

    // Confidence heuristics:
  // - absolute score (0..1)
  // - separation from 2nd best
  const separation = bestScore - (Number.isFinite(secondBestScore) ? secondBestScore : 0);

  let confidence = 'low';
  // Slightly more forgiving thresholds so typical worship songs
  // will often show "high" when the key profile is clear.
  if (bestScore >= 0.5 && separation >= 0.05) {
    confidence = 'high';
  }

  return {
    tonicIndex: bestTonic,                       // 0..11
    tonicName: PITCH_CLASS_NAMES[bestTonic],     // e.g. "F#"
    mode: bestMode,                              // "major" or "minor"
    confidence,                                  // "high" or "low"
    score: bestScore,                            // raw similarity
  };
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

// /prepare: download audio once, store it, return trackId + duration + key
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

    // Step 2: download & convert to MP3 once, into our cache
    console.log('Downloading audio (MP3) to cache:', filePath);

    const dlProc = spawn('yt-dlp', [
      '--extractor-args',
      'youtube:player_client=default',
      '--cookies',
      'cookies.txt',

      '--js-runtimes',
      'node',
      '--remote-components',
      'ejs:github',

      '-N',
      '1',
      '--no-playlist',

      // Extract audio and convert to MP3 using yt-dlp + ffmpeg
      '--extract-audio',
      '--audio-format',
      'mp3',
      '--audio-quality',
      '5', // good quality

      '-o',
      filePath,
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
        // First try ffprobe on the downloaded file to get precise duration
        const probed = await probeDurationSeconds(filePath);
        const finalDuration =
          Number.isFinite(probed) && probed > 0 ? probed : duration;

        // Run key detection on the cached MP3 (best-effort)
        let keyInfo = null;
        try {
          keyInfo = await detectKeyForFile(filePath);
        } catch (e) {
          console.error('Key detection threw error:', e);
        }

        // Register track in memory with key info
        tracks[trackId] = {
          filePath,
          duration: finalDuration,
          createdAt: Date.now(),
          key: keyInfo,
        };

        console.log(
          'Track prepared:',
          trackId,
          'duration:',
          finalDuration,
          'key:',
          keyInfo || 'unknown'
        );

        return res.json({
          trackId,
          duration: finalDuration,
          key: keyInfo,
        });
      } catch (err) {
        console.error('Error probing duration or key:', err);

        // At least register the track with whatever duration we had (possibly 0)
        tracks[trackId] = {
          filePath,
          duration,
          createdAt: Date.now(),
          key: null,
        };

        return res.json({
          trackId,
          duration,
          key: null,
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