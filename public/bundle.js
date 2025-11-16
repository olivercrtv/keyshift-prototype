(() => {
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __commonJS = (cb, mod) => function __require() {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  };

  // public/app.js
  var require_app = __commonJS({
    "public/app.js"() {
      var titleHeading = document.getElementById("titleHeading");
      var urlInput = document.getElementById("urlInput");
      var loadButton = document.getElementById("loadButton");
      var semitoneSlider = document.getElementById("semitoneSlider");
      var semitoneValue = document.getElementById("semitoneValue");
      var statusText = document.getElementById("statusText");
      var audioElement = document.getElementById("audioElement");
      var playPauseButton = document.getElementById("playPauseButton");
      var seekSlider = document.getElementById("seekSlider");
      var currentTimeLabel = document.getElementById("currentTimeLabel");
      var durationLabel = document.getElementById("durationLabel");
      var volumeSlider = document.getElementById("volumeSlider");
      var restartButton = document.getElementById("restartButton");
      var endButton = document.getElementById("endButton");
      var searchInput = document.getElementById("searchInput");
      var searchButton = document.getElementById("searchButton");
      var searchResults = document.getElementById("searchResults");
      var searchLoading = document.getElementById("searchLoading");
      var semitoneButtons = document.querySelectorAll(".semitone-btn");
      var pianoModeButton = document.getElementById("pianoModeButton");
      var audioCtx = null;
      var soundtouchNode = null;
      var audioSourceNode = null;
      var mainGainNode = null;
      var pitchShiftingAvailable = false;
      var currentSemitone = 0;
      var isContextReady = false;
      var currentTrackId = null;
      var currentVideoId = null;
      var SEMITONE_STORAGE_PREFIX = "keyshift:semitones:";
      var currentLoadToken = 0;
      var trackDuration = 0;
      var currentOffset = 0;
      var isUserSeeking = false;
      var pianoMode = "toggle";
      var activePianoOsc = null;
      var activePianoGain = null;
      var activePianoMidi = null;
      var activePianoButton = null;
      function setStatus(text) {
        statusText.textContent = text;
        if (text.startsWith("Audio prepared")) {
          statusText.classList.add("status-ready");
          statusText.scrollIntoView({
            behavior: "smooth",
            block: "center"
          });
        } else {
          statusText.classList.remove("status-ready");
        }
      }
      function extractYouTubeId(url) {
        try {
          const u = new URL(url);
          if (u.hostname === "youtu.be") {
            return u.pathname.slice(1);
          }
          const vParam = u.searchParams.get("v");
          if (vParam) return vParam;
          if (u.pathname.startsWith("/shorts/")) {
            const parts = u.pathname.split("/");
            return parts[2] || null;
          }
          return null;
        } catch (err) {
          console.warn("Could not parse YouTube URL for ID:", err);
          return null;
        }
      }
      function getStoredSemitone(videoId) {
        if (!videoId) return null;
        try {
          const raw = localStorage.getItem(SEMITONE_STORAGE_PREFIX + videoId);
          if (!raw) return null;
          const data = JSON.parse(raw);
          if (typeof data.semitones === "number") {
            return data.semitones;
          }
        } catch (err) {
          console.warn("Error reading stored semitone for", videoId, err);
        }
        return null;
      }
      function storeSemitone(videoId, semitone) {
        if (!videoId || typeof semitone !== "number" || Number.isNaN(semitone)) {
          return;
        }
        try {
          const payload = { semitones: semitone };
          localStorage.setItem(
            SEMITONE_STORAGE_PREFIX + videoId,
            JSON.stringify(payload)
          );
        } catch (err) {
          console.warn("Error storing semitone for", videoId, err);
        }
      }
      function stopActivePianoNote() {
        if (!audioCtx) {
          activePianoOsc = null;
          activePianoGain = null;
          activePianoMidi = null;
          if (activePianoButton) {
            activePianoButton.classList.remove("piano-key-active");
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
          activePianoButton.classList.remove("piano-key-active");
          activePianoButton = null;
        }
      }
      function formatTime(seconds) {
        if (!isFinite(seconds) || seconds < 0) return "0:00";
        const m = Math.floor(seconds / 60);
        const s = Math.floor(seconds % 60);
        return `${m}:${s.toString().padStart(2, "0")}`;
      }
      function midiToFreq(midi) {
        return 440 * Math.pow(2, (midi - 69) / 12);
      }
      function setLoading(isLoading) {
        if (isLoading) {
          loadButton.disabled = true;
          loadButton.textContent = "Loading\u2026";
          loadButton.classList.add("loading-button");
          if (searchResults) {
            searchResults.classList.add("search-disabled");
          }
        } else {
          loadButton.disabled = false;
          loadButton.textContent = "Load & Play";
          loadButton.classList.remove("loading-button");
          if (searchResults) {
            searchResults.classList.remove("search-disabled");
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
          if (audioCtx.state === "suspended") {
            await audioCtx.resume();
          }
          const now = audioCtx.currentTime;
          if (pianoMode === "toggle") {
            if (activePianoOsc) {
              stopActivePianoNote();
            }
            const osc = audioCtx.createOscillator();
            const gain = audioCtx.createGain();
            osc.type = "sine";
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
          if (pianoMode === "sustain") {
            if (activePianoOsc && activePianoMidi === midi) {
              stopActivePianoNote();
              return;
            }
            if (activePianoOsc) {
              stopActivePianoNote();
            }
            const osc = audioCtx.createOscillator();
            const gain = audioCtx.createGain();
            osc.type = "sine";
            osc.frequency.value = midiToFreq(midi);
            gain.gain.setValueAtTime(0, now);
            gain.gain.linearRampToValueAtTime(0.25, now + 0.01);
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
              activePianoButton.classList.remove("piano-key-active");
            }
            if (buttonEl) {
              buttonEl.classList.add("piano-key-active");
              activePianoButton = buttonEl;
            }
            return;
          }
        } catch (err) {
          console.error("Error playing piano note:", err);
        }
      }
      async function updateTitleVersion() {
        try {
          const res = await fetch("/version");
          if (!res.ok) return;
          const data = await res.json();
          if (data.version && titleHeading) {
            titleHeading.textContent = `keyshift-prototype v${data.version}`;
          }
        } catch (err) {
          console.warn("Could not fetch version:", err);
        }
      }
      async function searchYouTube(query) {
        const q = query.trim();
        if (!q) return [];
        setStatus("Searching\u2026");
        searchLoading.classList.remove("hidden");
        searchResults.innerHTML = '<div class="search-result-item"><div class="search-result-text"><span class="search-result-meta">Searching\u2026</span></div></div>';
        try {
          const res = await fetch(`/search?q=${encodeURIComponent(q)}`);
          if (!res.ok) {
            setStatus("Search error");
            searchResults.innerHTML = '<div class="search-result-item"><div class="search-result-text"><span class="search-result-meta">Search failed.</span></div></div>';
            return [];
          }
          const data = await res.json();
          const results = Array.isArray(data.results) ? data.results : [];
          if (!results.length) {
            searchResults.innerHTML = '<div class="search-result-item"><div class="search-result-text"><span class="search-result-meta">No results found.</span></div></div>';
          } else {
            setStatus("Search complete");
          }
          return results;
        } catch (err) {
          console.error("Search error:", err);
          setStatus("Search error");
          searchResults.innerHTML = '<div class="search-result-item"><div class="search-result-text"><span class="search-result-meta">Error during search.</span></div></div>';
          return [];
        } finally {
          searchLoading.classList.add("hidden");
        }
      }
      function renderSearchResults(results) {
        if (!results.length) return;
        searchResults.innerHTML = "";
        results.forEach((item) => {
          const el = document.createElement("div");
          el.className = "search-result-item";
          const thumb = document.createElement("img");
          thumb.className = "search-result-thumb";
          if (item.thumbnail) {
            thumb.src = item.thumbnail;
            thumb.alt = "";
          }
          const textWrap = document.createElement("div");
          textWrap.className = "search-result-text";
          const titleEl = document.createElement("div");
          titleEl.className = "search-result-title";
          titleEl.textContent = item.title || "(no title)";
          const metaEl = document.createElement("div");
          metaEl.className = "search-result-meta";
          const parts = [];
          if (item.uploader) parts.push(item.uploader);
          if (typeof item.duration === "number" && item.duration > 0) {
            parts.push(formatTime(item.duration));
          }
          metaEl.textContent = parts.join(" \u2022 ");
          textWrap.appendChild(titleEl);
          textWrap.appendChild(metaEl);
          if (item.thumbnail) {
            el.appendChild(thumb);
          }
          el.appendChild(textWrap);
          el.addEventListener("click", () => {
            if (!item.url) return;
            urlInput.value = item.url;
            urlInput.scrollIntoView({ behavior: "smooth", block: "center" });
            loadAndPlay(item.url);
          });
          searchResults.appendChild(el);
        });
      }
      async function setupAudioContext() {
        if (isContextReady && audioCtx) {
          return;
        }
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        mainGainNode = audioCtx.createGain();
        mainGainNode.gain.value = parseFloat(volumeSlider.value) || 1;
        mainGainNode.connect(audioCtx.destination);
        let soundtouchSupported = false;
        if (audioCtx.audioWorklet && audioCtx.audioWorklet.addModule) {
          try {
            await audioCtx.audioWorklet.addModule("soundtouch-worklet.js");
            soundtouchNode = new AudioWorkletNode(audioCtx, "soundtouch-processor");
            soundtouchNode.parameters.get("pitchSemitones").value = currentSemitone;
            soundtouchNode.parameters.get("tempo").value = 1;
            soundtouchNode.parameters.get("rate").value = 1;
            audioSourceNode = audioCtx.createMediaElementSource(audioElement);
            audioSourceNode.connect(soundtouchNode);
            soundtouchNode.connect(mainGainNode);
            soundtouchSupported = true;
            console.log("SoundTouch AudioWorklet enabled");
          } catch (err) {
            console.warn("SoundTouch AudioWorklet not available, falling back:", err);
          }
        }
        if (!soundtouchSupported) {
          if (!audioSourceNode) {
            audioSourceNode = audioCtx.createMediaElementSource(audioElement);
            audioSourceNode.connect(mainGainNode);
          }
          soundtouchNode = null;
        }
        isContextReady = true;
        if (soundtouchSupported) {
          setStatus("Audio context ready (pitch shifting enabled)");
        } else {
          setStatus(
            "Audio context ready. Pitch shifting is disabled in this environment (requires secure HTTPS to enable)."
          );
        }
        pitchShiftingAvailable = soundtouchSupported;
        updatePitchUIState();
      }
      async function playFromOffset(offsetSeconds) {
        if (!currentTrackId) {
          alert('No prepared track. Click "Load & Play" first.');
          return;
        }
        try {
          await setupAudioContext();
          if (audioCtx.state === "suspended") {
            await audioCtx.resume();
          }
          currentOffset = Math.max(0, offsetSeconds || 0);
          if (!isUserSeeking && trackDuration > 0) {
            const pct = currentOffset / trackDuration * 100;
            seekSlider.value = pct;
            currentTimeLabel.textContent = formatTime(currentOffset);
          }
          playPauseButton.textContent = "Pause";
          const sourceUrl = `/audio?trackId=${encodeURIComponent(
            currentTrackId
          )}&start=${currentOffset}`;
          audioElement.src = sourceUrl;
          setStatus("Buffering & playing from new position\u2026");
          try {
            await audioElement.play();
          } catch (err) {
            const msg = err && err.message ? err.message : "";
            if (err.name === "NotAllowedError" || msg.toLowerCase().includes("gesture") || msg.toLowerCase().includes("user interaction")) {
              setStatus("Audio is ready. Tap Play to start on this device.");
              playPauseButton.textContent = "Play";
              return;
            }
            throw err;
          }
          if (soundtouchNode) {
            const param = soundtouchNode.parameters.get("pitchSemitones");
            if (param) param.value = currentSemitone;
          }
          isUserSeeking = false;
          setStatus(`Playing (shift: ${currentSemitone} semitones)`);
        } catch (err) {
          console.error("Error in playFromOffset:", err);
          const msg = err && err.message ? err.message : "";
          if (err.name === "AbortError" || msg.includes("The play() request was interrupted") || msg.includes("interrupted by a new load request")) {
            setStatus("Seek interrupted.");
          } else {
            alert("There was a problem loading this track position.");
            setStatus("Error loading audio");
          }
        }
      }
      async function loadAndPlay(url) {
        const trimmed = (url || "").trim();
        if (!trimmed) {
          alert("Paste a YouTube URL or use search first.");
          return;
        }
        const myToken = ++currentLoadToken;
        setLoading(true);
        setStatus("Preparing audio (downloading once)\u2026");
        currentVideoId = extractYouTubeId(trimmed);
        currentTrackId = null;
        trackDuration = 0;
        currentOffset = 0;
        audioElement.pause();
        audioElement.removeAttribute("src");
        seekSlider.value = 0;
        currentTimeLabel.textContent = "0:00";
        durationLabel.textContent = "0:00";
        try {
          const res = await fetch(`/prepare?url=${encodeURIComponent(trimmed)}`);
          if (!res.ok) {
            if (myToken === currentLoadToken) {
              setStatus("Error preparing audio");
              alert("There was a problem preparing this YouTube link.");
            }
            return;
          }
          const data = await res.json();
          if (myToken !== currentLoadToken) {
            console.log("Stale load result ignored.");
            return;
          }
          currentTrackId = data.trackId;
          trackDuration = data.duration || 0;
          if (trackDuration > 0) {
            durationLabel.textContent = formatTime(trackDuration);
          }
          if (currentVideoId) {
            const saved = getStoredSemitone(currentVideoId);
            if (typeof saved === "number") {
              semitoneSlider.value = String(saved);
              onSemitoneChange(saved);
            } else {
              semitoneSlider.value = "0";
              onSemitoneChange(0);
            }
          } else {
            semitoneSlider.value = "0";
            onSemitoneChange(0);
          }
          setStatus("Audio prepared. Tap Play to start.");
          playPauseButton.textContent = "Play";
        } catch (err) {
          console.error("Error in loadAndPlay:", err);
          if (myToken === currentLoadToken) {
            setStatus("Error preparing audio");
            alert("There was a problem preparing this YouTube link.");
          }
        } finally {
          if (myToken === currentLoadToken) {
            setLoading(false);
          }
        }
      }
      function onSemitoneChange(value) {
        currentSemitone = value;
        semitoneValue.textContent = value.toString();
        if (soundtouchNode) {
          const param = soundtouchNode.parameters.get("pitchSemitones");
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
        if (currentVideoId) {
          storeSemitone(currentVideoId, value);
        }
      }
      document.querySelectorAll(".piano-key").forEach((btn) => {
        btn.addEventListener("click", () => {
          const midi = parseInt(btn.dataset.midi, 10);
          if (!isNaN(midi)) {
            playPianoNote(midi, btn);
          }
        });
      });
      pianoModeButton.addEventListener("click", () => {
        if (pianoMode === "toggle") {
          pianoMode = "sustain";
          pianoModeButton.textContent = "Sustain";
        } else {
          pianoMode = "toggle";
          pianoModeButton.textContent = "Toggle";
          if (activePianoOsc) {
            stopActivePianoNote();
          }
        }
      });
      loadButton.addEventListener("click", async () => {
        const url = urlInput.value.trim();
        await loadAndPlay(url);
      });
      searchButton.addEventListener("click", async () => {
        const q = searchInput.value;
        const results = await searchYouTube(q);
        renderSearchResults(results);
      });
      searchInput.addEventListener("keydown", async (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          const q = searchInput.value;
          const results = await searchYouTube(q);
          renderSearchResults(results);
        }
      });
      semitoneSlider.addEventListener("input", (e) => {
        const v = parseInt(e.target.value, 10) || 0;
        onSemitoneChange(v);
      });
      semitoneButtons.forEach((btn) => {
        btn.addEventListener("click", () => {
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
      playPauseButton.addEventListener("click", async () => {
        try {
          if (!currentTrackId) {
            alert('Load a song first (use "Load & Play" or search, then tap a result).');
            return;
          }
          await setupAudioContext();
          if (audioCtx.state === "suspended") {
            await audioCtx.resume();
          }
          if (!audioElement.src) {
            await playFromOffset(currentOffset || 0);
            playPauseButton.textContent = "Pause";
            return;
          }
          if (audioElement.paused) {
            await audioElement.play();
            playPauseButton.textContent = "Pause";
            setStatus(`Playing (shift: ${currentSemitone} semitones)`);
          } else {
            audioElement.pause();
            playPauseButton.textContent = "Play";
            setStatus("Paused");
          }
        } catch (err) {
          console.error("Error in playPauseButton handler:", err);
        }
      });
      restartButton.addEventListener("click", () => {
        if (!currentTrackId) return;
        seekSlider.value = 0;
        currentTimeLabel.textContent = "0:00";
        playFromOffset(0);
      });
      endButton.addEventListener("click", () => {
        if (!currentTrackId || trackDuration <= 0) return;
        const target = Math.max(0, trackDuration - 1);
        const pct = target / trackDuration * 100;
        seekSlider.value = pct;
        currentTimeLabel.textContent = formatTime(target);
        playFromOffset(target);
      });
      audioElement.addEventListener("timeupdate", () => {
        if (isUserSeeking) return;
        const relative = audioElement.currentTime || 0;
        const absolute = currentOffset + relative;
        currentTimeLabel.textContent = formatTime(absolute);
        if (trackDuration > 0 && isFinite(trackDuration)) {
          const pct = absolute / trackDuration * 100;
          seekSlider.value = Math.max(0, Math.min(100, pct));
        }
      });
      audioElement.addEventListener("ended", () => {
        playPauseButton.textContent = "Play";
        setStatus("Finished");
      });
      seekSlider.addEventListener("mousedown", () => {
        isUserSeeking = true;
      });
      seekSlider.addEventListener("touchstart", () => {
        isUserSeeking = true;
      });
      seekSlider.addEventListener("input", () => {
        if (trackDuration <= 0) return;
        isUserSeeking = true;
        const pct = parseFloat(seekSlider.value) || 0;
        const targetAbs = pct / 100 * trackDuration;
        currentTimeLabel.textContent = formatTime(targetAbs);
      });
      function finishSeek() {
        if (trackDuration <= 0) {
          isUserSeeking = false;
          return;
        }
        const pct = parseFloat(seekSlider.value) || 0;
        const targetAbs = pct / 100 * trackDuration;
        isUserSeeking = false;
        playFromOffset(targetAbs);
      }
      seekSlider.addEventListener("mouseup", finishSeek);
      seekSlider.addEventListener("touchend", finishSeek);
      seekSlider.addEventListener("change", finishSeek);
      volumeSlider.addEventListener("input", () => {
        const v = parseFloat(volumeSlider.value);
        const vol = isNaN(v) ? 1 : v;
        if (mainGainNode) {
          mainGainNode.gain.value = vol;
        } else {
          audioElement.volume = vol;
        }
      });
      document.getElementById("footerYear").textContent = (/* @__PURE__ */ new Date()).getFullYear();
      setStatus("Idle");
      semitoneValue.textContent = semitoneSlider.value;
      currentTimeLabel.textContent = "0:00";
      durationLabel.textContent = "0:00";
      seekSlider.value = 0;
      audioElement.volume = 1;
      playPauseButton.textContent = "Play";
      updateTitleVersion();
    }
  });
  require_app();
})();
