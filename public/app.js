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

const semitoneButtons = document.querySelectorAll('.semitone-btn');
const resetSemitoneButton = document.getElementById('resetSemitoneButton');

const pianoModeButton = document.getElementById('pianoModeButton');

const keyMemoryBadge = document.getElementById('keyMemoryBadge');

let audioCtx = null;
let soundtouchNode = null;
let audioSourceNode = null;
let mainGainNode = null;

let pitchShiftingAvailable = false;

let currentSemitone = 0;
let isContextReady = false;

let currentTrackId = null;

let currentVideoId = null;
const SEMITONE_STORAGE_PREFIX = 'keyshift:semitones:';

let currentLoadToken = 0;

let trackDuration = 0;      // seconds
let isUserSeeking = false;

let pianoMode = 'toggle'; // 'toggle' or 'sustain'
let activePianoOsc = null;
let activePianoGain = null;
let activePianoMidi = null;
let activePianoButton = null;

let pianoCtx = null;
let pianoMasterGain = null;

let loadingTimer = null;
let loadingSeconds = 0;

function setStatus(text) {
  statusText.textContent = text;

  if (text.startsWith('Audio prepared')) {
    statusText.classList.add('status-ready');
    statusText.scrollIntoView({ behavior: 'smooth', block: 'center' });
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
  if (!pianoCtx) {
    activePianoOsc = null;
    activePianoGain = null;
    activePianoMidi = null;
    if (activePianoButton) {
      activePianoButton.classList.remove('piano-key-active');
      activePianoButton = null;
    }
    return;
  }

  const now = pianoCtx.currentTime;

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

function playPianoNote(midi, buttonEl) {
  try {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return;

    // Create piano context lazily on first tap
    if (!pianoCtx) {
      pianoCtx = new Ctor();

      pianoMasterGain = pianoCtx.createGain();
      pianoMasterGain.gain.value = 0.55; // <-- Bump piano volume!
      pianoMasterGain.connect(pianoCtx.destination);
    }

    // iOS requires resume() on gesture
    if (pianoCtx.state === 'suspended') {
      pianoCtx.resume().catch(() => {});
    }

    const now = pianoCtx.currentTime;

    // --- Toggle (short note) mode ---
    if (pianoMode === 'toggle') {
      const osc = pianoCtx.createOscillator();
      const g = pianoCtx.createGain();

      osc.type = 'sine';
      osc.frequency.value = midiToFreq(midi);

      g.gain.setValueAtTime(0, now);
      g.gain.linearRampToValueAtTime(0.35, now + 0.01); // louder attack
      g.gain.linearRampToValueAtTime(0, now + 0.55);

      osc.connect(g);
      g.connect(pianoMasterGain);

      osc.start(now);
      osc.stop(now + 0.55);
      return;
    }

    // --- Sustain (toggle on/off) mode ---
    if (pianoMode === 'sustain') {
      if (activePianoOsc && activePianoMidi === midi) {
        stopActivePianoNote();
        return;
      }

      if (activePianoOsc) stopActivePianoNote();

      const osc = pianoCtx.createOscillator();
      const g = pianoCtx.createGain();

      osc.type = 'sine';
      osc.frequency.value = midiToFreq(midi);

      g.gain.setValueAtTime(0, now);
      g.gain.linearRampToValueAtTime(0.35, now + 0.01);

      osc.connect(g);
      g.connect(pianoMasterGain);

      osc.start(now);

      activePianoOsc = osc;
      activePianoGain = g;
      activePianoMidi = midi;

      if (activePianoButton) activePianoButton.classList.remove('piano-key-active');
      if (buttonEl) {
        buttonEl.classList.add('piano-key-active');
        activePianoButton = buttonEl;
      }
    }
  } catch (err) {
    console.error('Error playing piano note:', err);
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
    loadButton.classList.add('loading-button');
    if (searchResults) {
      searchResults.classList.add('search-disabled');
    }

    loadingSeconds = 0;
    loadButton.textContent = 'Loading… (0s)';

    if (loadingTimer) clearInterval(loadingTimer);
    loadingTimer = setInterval(() => {
      loadingSeconds += 1;
      loadButton.textContent = `Loading… (${loadingSeconds}s)`;
    }, 1000);
  } else {
    loadButton.disabled = false;
    loadButton.classList.remove('loading-button');
    loadButton.textContent = 'Load & Play';
    if (searchResults) {
      searchResults.classList.remove('search-disabled');
    }

    if (loadingTimer) {
      clearInterval(loadingTimer);
      loadingTimer = null;
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
    const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
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
      setStatus('Search complete – showing top results.');
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
    titleEl.textContent = item.title ? decodeHtmlEntities(item.title) : '(no title)';

    const metaEl = document.createElement('div');
    metaEl.className = 'search-result-meta';

    const parts = [];
    if (item.uploader) parts.push(decodeHtmlEntities(item.uploader));
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

  // Try AudioWorklet-based SoundTouch first
  if (audioCtx.audioWorklet && audioCtx.audioWorklet.addModule) {
    try {
      // IMPORTANT: absolute path so it resolves correctly on mobile + HTTPS
      await audioCtx.audioWorklet.addModule('/soundtouch-worklet.js');

      soundtouchNode = new AudioWorkletNode(audioCtx, 'soundtouch-processor');
      soundtouchNode.parameters.get('pitchSemitones').value = currentSemitone;
      soundtouchNode.parameters.get('tempo').value = 1.0;
      soundtouchNode.parameters.get('rate').value = 1.0;

      // Only create the media source once
      if (!audioSourceNode) {
        audioSourceNode = audioCtx.createMediaElementSource(audioElement);
      }
      audioSourceNode.connect(soundtouchNode);
      soundtouchNode.connect(mainGainNode);

      soundtouchSupported = true;
      console.log('SoundTouch AudioWorklet enabled');
    } catch (err) {
      console.warn('SoundTouch AudioWorklet not available, falling back:', err);
      // Show a hint in the UI so we know *why* it failed on mobile
      setStatus(
        'Audio context ready, but advanced pitch shifting is not supported in this browser.'
      );
    }
  }

  // Fallback: no AudioWorklet / SoundTouch, just connect audio directly
  if (!soundtouchSupported) {
    if (!audioSourceNode) {
      audioSourceNode = audioCtx.createMediaElementSource(audioElement);
    }
    audioSourceNode.connect(mainGainNode);
    soundtouchNode = null; // explicitly note that pitch shift is disabled
  }

  isContextReady = true;

  if (soundtouchSupported) {
    setStatus('Audio context ready (pitch shifting enabled)');
  } else {
    setStatus(
      'Audio context ready. Pitch shifting is disabled in this environment.'
    );
  }

  pitchShiftingAvailable = soundtouchSupported;
  updatePitchUIState();
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


    // NEW: set the audio src once
    audioElement.src = `/audio?trackId=${encodeURIComponent(currentTrackId)}`;
    audioElement.currentTime = 0;

    // Restore saved semitone for this video if available
    if (currentVideoId) {
      const saved = getStoredSemitone(currentVideoId);
      if (typeof saved === 'number') {
        semitoneSlider.value = String(saved);
        onSemitoneChange(saved);
          flashKeyMemoryBadge();   // <--- add this line
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

function flashKeyMemoryBadge() {
  if (!keyMemoryBadge) return;
  keyMemoryBadge.classList.add('visible');
  setTimeout(() => {
    keyMemoryBadge.classList.remove('visible');
  }, 1600);
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

if (resetSemitoneButton) {
  resetSemitoneButton.addEventListener('click', () => {
    semitoneSlider.value = '0';
    onSemitoneChange(0);
  });
}

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

    // First play after prepare: ensure src exists
if (!audioElement.src) {
  if (!currentTrackId) {
    alert('Load a song first.');
    return;
  }
  audioElement.src = `/audio?trackId=${encodeURIComponent(currentTrackId)}`;
  audioElement.currentTime = 0;
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
  audioElement.currentTime = 0;
});

endButton.addEventListener('click', () => {
  if (!currentTrackId || trackDuration <= 0) return;

  const target = Math.max(0, trackDuration - 1);
  const pct = (target / trackDuration) * 100;

  seekSlider.value = pct;
  currentTimeLabel.textContent = formatTime(target);
  audioElement.currentTime = target;
});

// Audio element events: update progress/time based on absolute position
audioElement.addEventListener('timeupdate', () => {
  if (isUserSeeking) return;

  const absolute = audioElement.currentTime || 0;

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

audioElement.addEventListener('loadedmetadata', () => {
  // If the backend didn't give us a duration, use the media's own duration as a fallback
  if (!trackDuration || !isFinite(trackDuration) || trackDuration <= 0) {
    const d = audioElement.duration;
    if (Number.isFinite(d) && d > 0) {
      trackDuration = d;
      durationLabel.textContent = formatTime(trackDuration);
    }
  }
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

  // Tell the browser to seek within the MP3 we've already loaded
  audioElement.currentTime = targetAbs;
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

function decodeHtmlEntities(str) {
  const txt = document.createElement('textarea');
  txt.innerHTML = str;
  return txt.value;
}

// Auto-update footer year
document.getElementById('footerYear').textContent = new Date().getFullYear();

document.addEventListener('keydown', (e) => {
  if (e.code !== 'Space') return;

  const target = e.target;
  const tag = target && target.tagName;
  const type = target && target.type;

  // If user is typing in a normal text field (search, URL, etc.), let space insert a space
  if (tag === 'INPUT' && type !== 'range') {
    return;
  }

  if (tag === 'TEXTAREA' || (target && target.isContentEditable)) {
    // Let space behave normally in any text area / contenteditable field
    return;
  }

  // Everywhere else (including sliders): use spacebar as play/pause
  e.preventDefault();
  if (playPauseButton) {
    playPauseButton.click();
  }
});

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