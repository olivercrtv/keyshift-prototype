// public/app.js
// keyshift-prototype: download-once cache + SoundTouchJS + seek

const titleHeading = document.getElementById('titleHeading');
const urlInput = document.getElementById('urlInput');
const loadButton = document.getElementById('loadButton');
const semitoneSlider = document.getElementById('semitoneSlider');
const semitoneValue = document.getElementById('semitoneValue');
const statusText = document.getElementById('statusText');
const audioElement = document.getElementById('audioElement');

const playPauseButton = document.getElementById('playPauseButton');
const seekSlider = document.getElementById('seekSlider');
const currentTimeLabel = document.getElementById('currentTimeLabel');
const durationLabel = document.getElementById('durationLabel');
const volumeSlider = document.getElementById('volumeSlider');

const restartButton = document.getElementById('restartButton');
const endButton = document.getElementById('endButton');

// --- Search elements ---
const searchInput = document.getElementById('searchInput');
const searchButton = document.getElementById('searchButton');
const searchResults = document.getElementById('searchResults');
const searchStatus = document.getElementById('searchStatus'); // ok if null; we'll guard it

function setSearchStatus(message) {
  if (searchStatus) {
    searchStatus.textContent = message;
  } else {
    console.log('[searchStatus]', message);
  }
}

function clearSearchResults() {
  if (!searchResults) return;
  searchResults.innerHTML = '';
}

function renderSearchResults(results) {
  if (!searchResults) return;
  clearSearchResults();

  if (!results || results.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'search-empty';
    empty.textContent = 'No results. Try a more specific title or paste a YouTube link above.';
    searchResults.appendChild(empty);
    return;
  }

  const list = document.createElement('ul');
  list.className = 'search-results-list';

  results.forEach((item) => {
    const li = document.createElement('li');
    li.className = 'search-result-item';

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'search-result-button';
    button.addEventListener('click', () => {
      // When a result is clicked, copy URL into the main URL box and trigger load
      const urlInput = document.getElementById('urlInput');
      if (urlInput) {
        urlInput.value = item.url || '';
      }
      if (typeof loadAndPlay === 'function') {
        loadAndPlay();
      } else {
        // fallback: click the Load & Play button if available
        const loadBtn = document.getElementById('loadButton');
        if (loadBtn) loadBtn.click();
      }
    });

    const title = document.createElement('div');
    title.className = 'search-result-title';
    title.textContent = item.title || 'Untitled';

    const meta = document.createElement('div');
    meta.className = 'search-result-meta';
    meta.textContent = item.channel || '';

    button.appendChild(title);
    button.appendChild(meta);
    li.appendChild(button);
    list.appendChild(li);
  });

  searchResults.appendChild(list);
}

async function performSearch() {
  if (!searchInput || !searchButton) {
    console.warn('Search elements not found in DOM.');
    return;
  }

  const query = searchInput.value.trim();
  if (!query) {
    setSearchStatus('Type a song title or artist to search.');
    clearSearchResults();
    return;
  }

  try {
    // UI: loading state
    searchButton.disabled = true;
    searchButton.textContent = 'Searching…';
    setSearchStatus('Searching (top 3 results)…');

    const resp = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
    if (!resp.ok) {
      console.error('Search HTTP error:', resp.status);
      setSearchStatus('Search failed. Try a more specific query or paste a YouTube link.');
      clearSearchResults();
      return;
    }

    const data = await resp.json();
    console.log('Search data from server:', data);
    renderSearchResults(data.results || []);
    setSearchStatus('Showing top 3 results. If you don’t see your song, try a more specific search.');

  } catch (err) {
    console.error('Search fetch error:', err);
    setSearchStatus('Search failed. Check your connection or paste a YouTube link instead.');
    clearSearchResults();
  } finally {
    // restore button
    searchButton.disabled = false;
    searchButton.textContent = 'Search';
  }
}

// Wire up events
if (searchButton) {
  searchButton.addEventListener('click', (e) => {
    e.preventDefault();
    performSearch();
  });
}

if (searchInput) {
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      performSearch();
    }
  });
}

const semitoneButtons = document.querySelectorAll('.semitone-btn');

const pianoModeButton = document.getElementById('pianoModeButton');

let audioCtx = null;
let soundtouchNode = null;
let audioSourceNode = null;
let mainGainNode = null;

let pitchShiftingAvailable = false;

let currentSemitone = 0;
let isContextReady = false;

let currentUrl = '';
let currentTrackId = null;

let currentVideoId = null;
const SEMITONE_STORAGE_PREFIX = 'keyshift:semitones:';

let currentLoadToken = 0;

let trackDuration = 0;      // seconds
let currentOffset = 0;      // where this stream starts, in seconds
let isUserSeeking = false;
let isSeekInFlight = false;

let pianoMode = 'toggle'; // 'toggle' or 'sustain'
let activePianoOsc = null;
let activePianoGain = null;
let activePianoMidi = null;
let activePianoButton = null;

function setStatus(text) {
  statusText.textContent = text;

  if (text.startsWith('Audio prepared')) {
    statusText.classList.add('status-ready');

    // Auto-scroll status into view (useful on mobile)
    statusText.scrollIntoView({
      behavior: 'smooth',
      block: 'center',
    });
  } else {
    statusText.classList.remove('status-ready');
  }
}

function extractYouTubeId(url) {
  try {
    const u = new URL(url);

    // youtu.be/VIDEOID
    if (u.hostname === 'youtu.be') {
      return u.pathname.slice(1);
    }

    // Standard watch URL: youtube.com/watch?v=VIDEOID
    const vParam = u.searchParams.get('v');
    if (vParam) return vParam;

    // Shorts: youtube.com/shorts/VIDEOID
    if (u.pathname.startsWith('/shorts/')) {
      const parts = u.pathname.split('/');
      return parts[2] || null;
    }

    return null;
  } catch (err) {
    console.warn('Could not parse YouTube URL for ID:', err);
    return null;
  }
}

function getStoredSemitone(videoId) {
  if (!videoId) return null;
  try {
    const raw = localStorage.getItem(SEMITONE_STORAGE_PREFIX + videoId);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (typeof data.semitones === 'number') {
      return data.semitones;
    }
  } catch (err) {
    console.warn('Error reading stored semitone for', videoId, err);
  }
  return null;
}

function storeSemitone(videoId, semitone) {
  if (!videoId || typeof semitone !== 'number' || Number.isNaN(semitone)) {
    return;
  }
  try {
    const payload = { semitones: semitone };
    localStorage.setItem(
      SEMITONE_STORAGE_PREFIX + videoId,
      JSON.stringify(payload)
    );
  } catch (err) {
    console.warn('Error storing semitone for', videoId, err);
  }
}

function stopActivePianoNote() {
  if (!audioCtx) {
    activePianoOsc = null;
    activePianoGain = null;
    activePianoMidi = null;
    if (activePianoButton) {
      activePianoButton.classList.remove('piano-key-active');
      activePianoButton = null;
    }
    return;
  }

  const now = audioCtx.currentTime;

  if (activePianoGain) {
    activePianoGain.gain.cancelScheduledValues(now);
    activePianoGain.gain.setTargetAtTime(0, now, 0.05);
  }
  if (activePianoOsc) {
    activePianoOsc.stop(now + 0.1);
  }

  activePianoOsc = null;
  activePianoGain = null;
  activePianoMidi = null;

  if (activePianoButton) {
    activePianoButton.classList.remove('piano-key-active');
    activePianoButton = null;
  }
}

function validateYouTubeUrl(url) {
  if (!url) return false;
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

function formatTime(seconds) {
  if (!isFinite(seconds) || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function midiToFreq(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function setLoading(isLoading) {
  if (isLoading) {
    loadButton.disabled = true;
    loadButton.textContent = 'Loading…';
    loadButton.classList.add('loading-button');
    if (searchResults) {
      searchResults.classList.add('search-disabled');
    }
  } else {
    loadButton.disabled = false;
    loadButton.textContent = 'Load & Play';
    loadButton.classList.remove('loading-button');
    if (searchResults) {
      searchResults.classList.remove('search-disabled');
    }
  }
}

function updatePitchUIState() {
  const disabled = !pitchShiftingAvailable;
  semitoneSlider.disabled = disabled;
  semitoneButtons.forEach((btn) => {
    btn.disabled = disabled;
  });
}

async function playPianoNote(midi, buttonEl) {
  try {
    await setupAudioContext();
    if (audioCtx.state === 'suspended') {
      await audioCtx.resume();
    }

    const now = audioCtx.currentTime;

    // TOGGLE MODE: short blip (original behavior)
    if (pianoMode === 'toggle') {
      // Ensure any sustained note is stopped/cleared
      if (activePianoOsc) {
        stopActivePianoNote();
      }

      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();

      osc.type = 'sine';
      osc.frequency.value = midiToFreq(midi);

      const duration = 0.6;

      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.25, now + 0.01);
      gain.gain.linearRampToValueAtTime(0, now + duration);

      osc.connect(gain);
      if (mainGainNode) {
        gain.connect(mainGainNode);
      } else {
        gain.connect(audioCtx.destination);
      }

      osc.start(now);
      osc.stop(now + duration);
      return;
    }

    // SUSTAIN MODE: toggle on/off
    if (pianoMode === 'sustain') {
      // If this note is already active, turn it off
      if (activePianoOsc && activePianoMidi === midi) {
        stopActivePianoNote();
        return;
      }

      // Switch to a new sustained note
      if (activePianoOsc) {
        stopActivePianoNote();
      }

      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();

      osc.type = 'sine';
      osc.frequency.value = midiToFreq(midi);

      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.25, now + 0.01);
      // No scheduled ramp down; sustaining

      osc.connect(gain);
      if (mainGainNode) {
        gain.connect(mainGainNode);
      } else {
        gain.connect(audioCtx.destination);
      }

      osc.start(now);

      activePianoOsc = osc;
      activePianoGain = gain;
      activePianoMidi = midi;

      if (activePianoButton) {
        activePianoButton.classList.remove('piano-key-active');
      }
      if (buttonEl) {
        buttonEl.classList.add('piano-key-active');
        activePianoButton = buttonEl;
      }

      return;
    }
  } catch (err) {
    console.error('Error playing piano note:', err);
  }
}

/**
 * Fetch version from /version and update heading
 */
async function updateTitleVersion() {
  try {
    const res = await fetch('/version');
    if (!res.ok) return;
    const data = await res.json();
    if (data.version && titleHeading) {
      titleHeading.textContent = `keyshift-prototype v${data.version}`;
    }
  } catch (err) {
    console.warn('Could not fetch version:', err);
  }
}

/**
 * Search YouTube via backend /search and return results array.
 */
async function searchYouTube(query) {
  const q = query.trim();
  if (!q) return [];

  setStatus('Searching…');
  searchLoading.classList.remove('hidden');
  searchResults.innerHTML =
    '<div class="search-result-item"><div class="search-result-text"><span class="search-result-meta">Searching…</span></div></div>';

  try {
    const res = await fetch(`/search?q=${encodeURIComponent(q)}`);
    if (!res.ok) {
      setStatus('Search error');
      searchResults.innerHTML =
        '<div class="search-result-item"><div class="search-result-text"><span class="search-result-meta">Search failed.</span></div></div>';
      return [];
    }

    const data = await res.json();
    const results = Array.isArray(data.results) ? data.results : [];

    if (!results.length) {
      searchResults.innerHTML =
        '<div class="search-result-item"><div class="search-result-text"><span class="search-result-meta">No results found.</span></div></div>';
    } else {
      setStatus('Search complete');
    }

    return results;
  } catch (err) {
    console.error('Search error:', err);
    setStatus('Search error');
    searchResults.innerHTML =
      '<div class="search-result-item"><div class="search-result-text"><span class="search-result-meta">Error during search.</span></div></div>';
    return [];
  } finally {
    // Always hide loading bar at the end
    searchLoading.classList.add('hidden');
  }
}

/**
 * Render search results list and attach click handlers.
 */
function renderSearchResults(results) {
  if (!results.length) return;

  searchResults.innerHTML = '';

  results.forEach((item) => {
    const el = document.createElement('div');
    el.className = 'search-result-item';

    const thumb = document.createElement('img');
    thumb.className = 'search-result-thumb';
    if (item.thumbnail) {
      thumb.src = item.thumbnail;
      thumb.alt = '';
    }

    const textWrap = document.createElement('div');
    textWrap.className = 'search-result-text';

    const titleEl = document.createElement('div');
    titleEl.className = 'search-result-title';
    titleEl.textContent = item.title || '(no title)';

    const metaEl = document.createElement('div');
    metaEl.className = 'search-result-meta';

    const parts = [];
    if (item.uploader) parts.push(item.uploader);
    if (typeof item.duration === 'number' && item.duration > 0) {
      parts.push(formatTime(item.duration));
    }
    metaEl.textContent = parts.join(' • ');

    textWrap.appendChild(titleEl);
    textWrap.appendChild(metaEl);

    if (item.thumbnail) {
      el.appendChild(thumb);
    }
    el.appendChild(textWrap);

    // On click -> set URL field and start loading/playing
el.addEventListener('click', () => {
  if (!item.url) return;
  urlInput.value = item.url;
  urlInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
  loadAndPlay(item.url); // prepares; user will tap Play
});


    searchResults.appendChild(el);
  });
}

/**
 * Create the AudioContext and register the SoundTouch worklet.
 */
async function setupAudioContext() {
  if (isContextReady && audioCtx) {
    return;
  }

  audioCtx = new (window.AudioContext || window.webkitAudioContext)();

  // Main gain node for master volume control
  mainGainNode = audioCtx.createGain();
  mainGainNode.gain.value = parseFloat(volumeSlider.value) || 1;
  mainGainNode.connect(audioCtx.destination);

  let soundtouchSupported = false;

  if (audioCtx.audioWorklet && audioCtx.audioWorklet.addModule) {
    try {
      await audioCtx.audioWorklet.addModule('soundtouch-worklet.js');

      soundtouchNode = new AudioWorkletNode(audioCtx, 'soundtouch-processor');
      soundtouchNode.parameters.get('pitchSemitones').value = currentSemitone;
      soundtouchNode.parameters.get('tempo').value = 1.0;
      soundtouchNode.parameters.get('rate').value = 1.0;

      audioSourceNode = audioCtx.createMediaElementSource(audioElement);
      audioSourceNode.connect(soundtouchNode);
      soundtouchNode.connect(mainGainNode);

      soundtouchSupported = true;
      console.log('SoundTouch AudioWorklet enabled');
    } catch (err) {
      console.warn('SoundTouch AudioWorklet not available, falling back:', err);
    }
  }

  // Fallback: no AudioWorklet / SoundTouch, just connect audio directly
  if (!soundtouchSupported) {
    if (!audioSourceNode) {
      audioSourceNode = audioCtx.createMediaElementSource(audioElement);
      audioSourceNode.connect(mainGainNode);
    }
    soundtouchNode = null; // explicitly note that pitch shift is disabled
  }

  isContextReady = true;

  if (soundtouchSupported) {
    setStatus('Audio context ready (pitch shifting enabled)');
  } else {
    setStatus(
      'Audio context ready. Pitch shifting is disabled in this environment (requires secure HTTPS to enable).'
    );
  }

  pitchShiftingAvailable = soundtouchSupported;
  updatePitchUIState();
}

/**
 * Prepare a track: ask backend to download & cache audio.
 */
async function prepareTrack(url) {
  if (!validateYouTubeUrl(url)) {
    alert('Please paste a valid YouTube URL.');
    return null;
  }

  setStatus('Preparing audio (downloading once)…');
  currentTimeLabel.textContent = '0:00';
  durationLabel.textContent = '0:00';
  seekSlider.value = 0;

  const res = await fetch(`/prepare?url=${encodeURIComponent(url)}`);
  if (!res.ok) {
    alert('There was a problem preparing this YouTube link.');
    setStatus('Error preparing audio');
    return null;
  }

  const data = await res.json();
  if (!data.trackId) {
    alert('Server did not return a trackId.');
    setStatus('Error preparing audio');
    return null;
  }

  currentTrackId = data.trackId;
  trackDuration = typeof data.duration === 'number' ? data.duration : 0;

  if (trackDuration > 0) {
    durationLabel.textContent = formatTime(trackDuration);
  } else {
    durationLabel.textContent = '0:00';
  }

  setStatus('Audio prepared, starting playback…');
  return currentTrackId;
}

/**
 * Start playback from a specific offset (seconds) using cached track.
 */
async function playFromOffset(offsetSeconds) {
  if (!currentTrackId) {
    alert('No prepared track. Click "Load & Play" first.');
    return;
  }

  try {
    await setupAudioContext();
    if (audioCtx.state === 'suspended') {
      await audioCtx.resume();
    }

    currentOffset = Math.max(0, offsetSeconds || 0);

    // Update UI to reflect starting point
    if (!isUserSeeking && trackDuration > 0) {
      const pct = (currentOffset / trackDuration) * 100;
      seekSlider.value = pct;
      currentTimeLabel.textContent = formatTime(currentOffset);
    }
    playPauseButton.textContent = 'Pause';

    const sourceUrl = `/audio?trackId=${encodeURIComponent(
      currentTrackId
    )}&start=${currentOffset}`;

    audioElement.src = sourceUrl;

    setStatus('Buffering & playing from new position…');

    // Handle autoplay / gesture-related errors explicitly
    try {
      await audioElement.play();
    } catch (err) {
      const msg = err && err.message ? err.message : '';
      if (
        err.name === 'NotAllowedError' ||
        msg.toLowerCase().includes('gesture') ||
        msg.toLowerCase().includes('user interaction')
      ) {
        // Browser requires a manual Play tap
        setStatus('Audio is ready. Tap Play to start on this device.');
        playPauseButton.textContent = 'Play';
        return;
      }
      throw err;
    }

    if (soundtouchNode) {
      const param = soundtouchNode.parameters.get('pitchSemitones');
      if (param) param.value = currentSemitone;
    }

    isUserSeeking = false;
    setStatus(`Playing (shift: ${currentSemitone} semitones)`);

  } catch (err) {
    console.error('Error in playFromOffset:', err);
    const msg = err && err.message ? err.message : '';
    if (
      err.name === 'AbortError' ||
      msg.includes('The play() request was interrupted') ||
      msg.includes('interrupted by a new load request')
    ) {
      setStatus('Seek interrupted.');
    } else {
      alert('There was a problem loading this track position.');
      setStatus('Error loading audio');
    }
  }
}

/**
 * Load & play from the beginning: prepare track then start at 0.
 */
async function loadAndPlay(url) {
  const trimmed = (url || '').trim();
  if (!trimmed) {
    alert('Paste a YouTube URL or use search first.');
    return;
  }

  const myToken = ++currentLoadToken;
  setLoading(true);
  setStatus('Preparing audio (downloading once)…');

  // Identify which video this is (for per-song memory)
  currentVideoId = extractYouTubeId(trimmed);

  // Reset state
  currentTrackId = null;
  trackDuration = 0;
  currentOffset = 0;
  audioElement.pause();
  audioElement.removeAttribute('src');
  seekSlider.value = 0;
  currentTimeLabel.textContent = '0:00';
  durationLabel.textContent = '0:00';

  try {
    const res = await fetch(`/prepare?url=${encodeURIComponent(trimmed)}`);
    if (!res.ok) {
      if (myToken === currentLoadToken) {
        setStatus('Error preparing audio');
        alert('There was a problem preparing this YouTube link.');
      }
      return;
    }

    const data = await res.json();

    // If another load started after this one, ignore this result
    if (myToken !== currentLoadToken) {
      console.log('Stale load result ignored.');
      return;
    }

currentTrackId = data.trackId;
    trackDuration = data.duration || 0;

    if (trackDuration > 0) {
      durationLabel.textContent = formatTime(trackDuration);
    }

    // Restore saved semitone for this video if available
    if (currentVideoId) {
      const saved = getStoredSemitone(currentVideoId);
      if (typeof saved === 'number') {
        semitoneSlider.value = String(saved);
        onSemitoneChange(saved);
      } else {
        // Default to 0 if no saved value
        semitoneSlider.value = '0';
        onSemitoneChange(0);
      }
    } else {
      // No video ID; fall back to zero shift
      semitoneSlider.value = '0';
      onSemitoneChange(0);
    }

    setStatus('Audio prepared. Tap Play to start.');
    playPauseButton.textContent = 'Play';
  } catch (err) {
    console.error('Error in loadAndPlay:', err);
    if (myToken === currentLoadToken) {
      setStatus('Error preparing audio');
      alert('There was a problem preparing this YouTube link.');
    }
  } finally {
    if (myToken === currentLoadToken) {
      setLoading(false);
    }
  }
}

/**
 * Handle pitch changes in semitones.
 */
function onSemitoneChange(value) {
  currentSemitone = value;
  semitoneValue.textContent = value.toString();

  if (soundtouchNode) {
    const param = soundtouchNode.parameters.get('pitchSemitones');
    if (param) {
      param.value = value;
    }
  }

  if (audioElement && !audioElement.paused && audioElement.src) {
    setStatus(`Playing (shift: ${value} semitones)`);
  } else if (currentTrackId) {
    setStatus(`Paused (shift: ${value} semitones)`);
  } else {
    setStatus(`Idle (shift: ${value} semitones)`);
    }

  // Persist choice for this video (if we know which one it is)
  if (currentVideoId) {
    storeSemitone(currentVideoId, value);
  }
}

// --- UI wiring ---

// Piano key clicks
document.querySelectorAll('.piano-key').forEach((btn) => {
  btn.addEventListener('click', () => {
    const midi = parseInt(btn.dataset.midi, 10);
    if (!isNaN(midi)) {
      playPianoNote(midi, btn);
    }
  });
});

pianoModeButton.addEventListener('click', () => {
  if (pianoMode === 'toggle') {
    pianoMode = 'sustain';
    pianoModeButton.textContent = 'Sustain';
  } else {
    pianoMode = 'toggle';
    pianoModeButton.textContent = 'Toggle';
    // Turn off any sustained note when returning to toggle mode
    if (activePianoOsc) {
      stopActivePianoNote();
    }
  }
});

// Load & Play button
loadButton.addEventListener('click', async () => {
  const url = urlInput.value.trim();
  await loadAndPlay(url);
});

// Search button click
searchButton.addEventListener('click', async () => {
  const q = searchInput.value;
  const results = await searchYouTube(q);
  renderSearchResults(results);
});

// Pressing Enter in the search box triggers search
searchInput.addEventListener('keydown', async (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    const q = searchInput.value;
    const results = await searchYouTube(q);
    renderSearchResults(results);
  }
});

// Semitone slider
semitoneSlider.addEventListener('input', (e) => {
  const v = parseInt(e.target.value, 10) || 0;
  onSemitoneChange(v);
});

semitoneButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    const delta = parseInt(btn.dataset.delta, 10) || 0;
    let current = parseInt(semitoneSlider.value, 10);
    if (isNaN(current)) current = 0;

    let next = current + delta;
    const min = parseInt(semitoneSlider.min, 10);
    const max = parseInt(semitoneSlider.max, 10);

    if (!isNaN(min)) next = Math.max(min, next);
    if (!isNaN(max)) next = Math.min(max, next);

    semitoneSlider.value = String(next);
    onSemitoneChange(next);
  });
});

// Play / Pause button
playPauseButton.addEventListener('click', async () => {
  try {
    // Must have a prepared track first
    if (!currentTrackId) {
      alert('Load a song first (use "Load & Play" or search, then tap a result).');
      return;
    }

    await setupAudioContext();
    if (audioCtx.state === 'suspended') {
      await audioCtx.resume();
    }

    // First play after prepare: no src yet => start from currentOffset (usually 0)
    if (!audioElement.src) {
      await playFromOffset(currentOffset || 0);
      playPauseButton.textContent = 'Pause';
      return;
    }

    // Toggle pause / resume
    if (audioElement.paused) {
      await audioElement.play();
      playPauseButton.textContent = 'Pause';
      setStatus(`Playing (shift: ${currentSemitone} semitones)`);
    } else {
      audioElement.pause();
      playPauseButton.textContent = 'Play';
      setStatus('Paused');
    }
  } catch (err) {
    console.error('Error in playPauseButton handler:', err);
  }
});

restartButton.addEventListener('click', () => {
  if (!currentTrackId) return;

  seekSlider.value = 0;
  currentTimeLabel.textContent = '0:00';

  playFromOffset(0);
});

endButton.addEventListener('click', () => {
  if (!currentTrackId || trackDuration <= 0) return;

  const target = Math.max(0, trackDuration - 1);  // last playable second
  const pct = (target / trackDuration) * 100;

  seekSlider.value = pct;
  currentTimeLabel.textContent = formatTime(target);

  playFromOffset(target);
});

// Audio element events: update progress/time based on absolute position
audioElement.addEventListener('timeupdate', () => {
  if (isUserSeeking) return;

  const relative = audioElement.currentTime || 0;        // seconds since this stream started
  const absolute = currentOffset + relative;             // seconds from start of track

  currentTimeLabel.textContent = formatTime(absolute);

  if (trackDuration > 0 && isFinite(trackDuration)) {
    const pct = (absolute / trackDuration) * 100;
    seekSlider.value = Math.max(0, Math.min(100, pct));
  }
});

audioElement.addEventListener('ended', () => {
  playPauseButton.textContent = 'Play';
  setStatus('Finished');
});

// Seek slider: drag to new absolute position
seekSlider.addEventListener('mousedown', () => {
  isUserSeeking = true;
});

seekSlider.addEventListener('touchstart', () => {
  isUserSeeking = true;
});

// Any slider movement: preview the target time and mark that the user is seeking
seekSlider.addEventListener('input', () => {
  if (trackDuration <= 0) return;
  isUserSeeking = true;
  const pct = parseFloat(seekSlider.value) || 0;
  const targetAbs = (pct / 100) * trackDuration;
  currentTimeLabel.textContent = formatTime(targetAbs);
});

function finishSeek() {
  if (trackDuration <= 0) {
    isUserSeeking = false;
    return;
  }
  const pct = parseFloat(seekSlider.value) || 0;
  const targetAbs = (pct / 100) * trackDuration;
  isUserSeeking = false;
  playFromOffset(targetAbs);
}

// Mouse & touch end
seekSlider.addEventListener('mouseup', finishSeek);
seekSlider.addEventListener('touchend', finishSeek);
// Desktop/mobile "click & release" cases
seekSlider.addEventListener('change', finishSeek);

// Volume control
volumeSlider.addEventListener('input', () => {
  const v = parseFloat(volumeSlider.value);
  const vol = isNaN(v) ? 1 : v;

  if (mainGainNode) {
    mainGainNode.gain.value = vol;
  } else {
    // Fallback if context not ready yet
    audioElement.volume = vol;
  }
});

// Auto-update footer year
document.getElementById('footerYear').textContent = new Date().getFullYear();

// Initial UI state
setStatus('Idle');
semitoneValue.textContent = semitoneSlider.value;
currentTimeLabel.textContent = '0:00';
durationLabel.textContent = '0:00';
seekSlider.value = 0;
audioElement.volume = 1;
playPauseButton.textContent = 'Play';

// Update title with version from server
updateTitleVersion();