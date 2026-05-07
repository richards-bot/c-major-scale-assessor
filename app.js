import {
  SCALE,
  COUNT_IN_BEATS,
  PRE_ROLL_SECONDS,
  POST_ROLL_SECONDS,
  MIN_RMS,
  buildTimeline,
  analyseFrames,
  estimatePitch,
  centsOff,
  nearestNoteName,
  median,
} from './analysis-core.mjs';

const tempoInput = document.getElementById('tempo');
const pitchToleranceInput = document.getElementById('pitchTolerance');
const timingToleranceInput = document.getElementById('timingTolerance');
const startButton = document.getElementById('startButton');
const stopButton = document.getElementById('stopButton');
const tuningButton = document.getElementById('tuningButton');
const liveTunerButton = document.getElementById('liveTunerButton');
const statusEl = document.getElementById('status');
const noteGrid = document.getElementById('noteGrid');
const summaryEl = document.getElementById('summary');
const playbackEl = document.getElementById('playback');
const liveNoteEl = document.getElementById('liveNote');
const liveHzEl = document.getElementById('liveHz');
const liveCentsEl = document.getElementById('liveCents');
const liveStateEl = document.getElementById('liveState');
const liveLevelFillEl = document.getElementById('liveLevelFill');
const liveNeedleEl = document.getElementById('liveNeedle');

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const LIVE_HISTORY_SIZE = 5;

let audioContext;
let analyser;
let analysisBuffer;
let mediaRecorder;
let mediaStream;
let mediaSource;
let mediaChunks = [];
let analysisFrames = [];
let expectedTimeline = [];
let noteResults = [];
let analysisStartedAt = 0;
let audioLoopId = null;
let stopTimeoutId = null;
let isRecording = false;
let isLiveTunerOn = false;
let playbackHighlightId = null;
let activeToneStop = null;
let livePitchHistory = [];

function setStatus(message) {
  statusEl.textContent = message;
}

async function ensureAudioContext() {
  audioContext = audioContext || new AudioContext();
  if (audioContext.state !== 'running') {
    await audioContext.resume();
  }
  return audioContext;
}

function formatPitchText(result) {
  if (result.pitchErrorCents == null) return '—';
  const direction = result.pitchErrorCents >= 0 ? 'sharp' : 'flat';
  return `${Math.round(Math.abs(result.pitchErrorCents))} cents ${direction}`;
}

function formatTimingText(result) {
  if (result.timingErrorMs == null) return '—';
  const direction = result.timingErrorMs >= 0 ? 'late' : 'early';
  return `${Math.round(Math.abs(result.timingErrorMs))} ms ${direction}`;
}

function midiToFrequency(midi) {
  return 440 * 2 ** ((midi - 69) / 12);
}

function getNearestPitchInfo(frequency) {
  if (!Number.isFinite(frequency) || frequency <= 0) return null;
  const midi = Math.round(69 + 12 * Math.log2(frequency / 440));
  const targetFrequency = midiToFrequency(midi);
  const octave = Math.floor(midi / 12) - 1;
  const noteName = `${NOTE_NAMES[((midi % 12) + 12) % 12]}${octave}`;
  return {
    midi,
    noteName,
    targetFrequency,
    cents: centsOff(targetFrequency, frequency),
  };
}

function updateLiveIndicator(pitch, rms) {
  const levelPercent = Math.max(2, Math.min(100, (rms / 0.05) * 100));
  liveLevelFillEl.style.width = `${levelPercent}%`;

  if (pitch == null) {
    livePitchHistory = [];
    liveNeedleEl.style.left = '50%';
    liveNoteEl.textContent = '—';
    liveHzEl.textContent = '— Hz';
    liveCentsEl.textContent = '— cents';
    liveStateEl.textContent = rms >= MIN_RMS ? 'Signal present, but pitch is unstable.' : 'Waiting for a stable note.';
    return;
  }

  livePitchHistory.push(pitch);
  if (livePitchHistory.length > LIVE_HISTORY_SIZE) {
    livePitchHistory.shift();
  }

  const smoothedPitch = median(livePitchHistory) ?? pitch;
  const info = getNearestPitchInfo(smoothedPitch);
  if (!info) return;

  const cents = Math.max(-50, Math.min(50, info.cents));
  const position = ((cents + 50) / 100) * 100;
  liveNeedleEl.style.left = `${position}%`;

  liveNoteEl.textContent = info.noteName;
  liveHzEl.textContent = `${smoothedPitch.toFixed(1)} Hz`;
  liveCentsEl.textContent = `${Math.round(Math.abs(info.cents))} cents ${info.cents >= 0 ? 'sharp' : 'flat'}`;
  liveStateEl.textContent = `Nearest note: ${nearestNoteName(smoothedPitch)} · target ${info.targetFrequency.toFixed(1)} Hz`;
}

function renderExpectedNotes(results = []) {
  noteGrid.innerHTML = '';

  SCALE.forEach((note, index) => {
    const result = results[index] || {};
    const card = document.createElement('article');
    card.className = `note-card ${result.state || ''}`.trim();
    card.dataset.noteIndex = String(index);

    const detectedText = result.detectedFrequency
      ? `${result.detectedNoteName || '—'} · ${result.detectedFrequency.toFixed(1)} Hz`
      : '—';

    card.innerHTML = `
      <div class="note-card-top">
        <div>
          <h3>${index + 1}. ${note.name}</h3>
          <p class="sub">Target ${note.frequency.toFixed(2)} Hz · one beat</p>
        </div>
        <button class="note-play" data-frequency="${note.frequency}" data-note="${note.name}" type="button">Play tone</button>
      </div>
      <dl>
        <dt>Pitch</dt>
        <dd>${formatPitchText(result)}</dd>
        <dt>Timing</dt>
        <dd>${formatTimingText(result)}</dd>
        <dt>Detected</dt>
        <dd>${detectedText}</dd>
        <dt>Status</dt>
        <dd>${result.label || 'Waiting to record'}</dd>
      </dl>
    `;

    noteGrid.appendChild(card);
  });
}

function stopActiveTone() {
  if (activeToneStop) {
    activeToneStop();
    activeToneStop = null;
  }
}

async function playTone(frequency, { seconds = 1.25, type = 'sine', gain = 0.14 } = {}) {
  const ctx = await ensureAudioContext();
  stopActiveTone();

  const now = ctx.currentTime;
  const oscillator = ctx.createOscillator();
  const envelope = ctx.createGain();

  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, now);

  envelope.gain.setValueAtTime(0.0001, now);
  envelope.gain.exponentialRampToValueAtTime(gain, now + 0.02);
  envelope.gain.exponentialRampToValueAtTime(gain * 0.9, now + Math.max(0.12, seconds - 0.12));
  envelope.gain.exponentialRampToValueAtTime(0.0001, now + seconds);

  oscillator.connect(envelope);
  envelope.connect(ctx.destination);
  oscillator.start(now);
  oscillator.stop(now + seconds + 0.02);

  activeToneStop = () => {
    try {
      oscillator.stop();
    } catch {
      // already stopped
    }
    envelope.disconnect();
    oscillator.disconnect();
  };

  oscillator.addEventListener('ended', () => {
    if (activeToneStop) activeToneStop = null;
  });
}

function stopTracks() {
  if (mediaStream) {
    mediaStream.getTracks().forEach((track) => track.stop());
  }
  mediaStream = null;
  if (mediaSource) {
    try {
      mediaSource.disconnect();
    } catch {
      // noop
    }
  }
  mediaSource = null;
  analyser = null;
  analysisBuffer = null;
}

function stopAudioLoop() {
  if (audioLoopId) {
    cancelAnimationFrame(audioLoopId);
    audioLoopId = null;
  }
}

function maybeReleaseMicrophone() {
  if (!isRecording && !isLiveTunerOn) {
    stopAudioLoop();
    stopTracks();
    updateLiveIndicator(null, 0);
  }
}

async function ensureInputReady() {
  await ensureAudioContext();
  if (mediaStream && analyser && analysisBuffer) return;

  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
    video: false,
  });

  mediaSource = audioContext.createMediaStreamSource(mediaStream);
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 4096;
  analyser.smoothingTimeConstant = 0.05;
  analysisBuffer = new Float32Array(analyser.fftSize);
  mediaSource.connect(analyser);
}

function processAudioFrame() {
  if (!analyser || !analysisBuffer) {
    audioLoopId = null;
    return;
  }

  analyser.getFloatTimeDomainData(analysisBuffer);

  let rms = 0;
  for (let i = 0; i < analysisBuffer.length; i += 1) {
    rms += analysisBuffer[i] * analysisBuffer[i];
  }
  rms = Math.sqrt(rms / analysisBuffer.length);

  const pitch = estimatePitch(analysisBuffer, audioContext.sampleRate, { minRms: MIN_RMS });
  updateLiveIndicator(pitch, rms);

  if (isRecording) {
    const relativeTime = audioContext.currentTime - analysisStartedAt;
    analysisFrames.push({ time: relativeTime, rms, pitch });
  }

  if (isRecording || isLiveTunerOn) {
    audioLoopId = requestAnimationFrame(processAudioFrame);
  } else {
    audioLoopId = null;
    maybeReleaseMicrophone();
  }
}

function startAudioLoop() {
  if (audioLoopId) return;
  audioLoopId = requestAnimationFrame(processAudioFrame);
}

function clearRecordingState() {
  mediaChunks = [];
  analysisFrames = [];
  noteResults = [];
  expectedTimeline = [];
  playbackEl.removeAttribute('src');
  playbackEl.load();
  summaryEl.textContent = 'No recording yet.';
  renderExpectedNotes();
}

function scheduleMetronome(totalBeats, beatDuration) {
  const now = audioContext.currentTime;
  analysisStartedAt = now;

  for (let beat = 0; beat < totalBeats; beat += 1) {
    const when = now + PRE_ROLL_SECONDS + beat * beatDuration;
    const isCountIn = beat < COUNT_IN_BEATS;
    const isDownBeat = beat === COUNT_IN_BEATS;
    const frequency = isCountIn ? 1320 : isDownBeat ? 1180 : 920;
    const gainAmount = isDownBeat ? 0.2 : 0.13;

    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();

    oscillator.type = 'square';
    oscillator.frequency.setValueAtTime(frequency, when);
    gainNode.gain.setValueAtTime(0.0001, when);
    gainNode.gain.exponentialRampToValueAtTime(gainAmount, when + 0.002);
    gainNode.gain.exponentialRampToValueAtTime(0.0001, when + 0.05);

    oscillator.connect(gainNode);
    gainNode.connect(audioContext.destination);
    oscillator.start(when);
    oscillator.stop(when + 0.06);
  }
}

function analysePerformance() {
  const { noteResults: results, summary } = analyseFrames({
    analysisFrames,
    expectedTimeline,
    pitchTolerance: Number(pitchToleranceInput.value),
    timingTolerance: Number(timingToleranceInput.value),
  });

  noteResults = results;
  summaryEl.textContent = `${summary.passCount}/${noteResults.length} notes fully passed · ${summary.partialCount} partial · ${summary.failCount} failed/missed · median pitch error ${
    summary.medianPitchError == null ? '—' : `${Math.round(summary.medianPitchError)} cents`
  } · median timing error ${summary.medianTimingError == null ? '—' : `${Math.round(summary.medianTimingError)} ms`}.`;

  renderExpectedNotes(noteResults);
}

function finishRecording() {
  if (!isRecording) return;
  isRecording = false;

  if (stopTimeoutId) {
    clearTimeout(stopTimeoutId);
    stopTimeoutId = null;
  }

  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }

  stopButton.disabled = true;
  startButton.disabled = false;
  setStatus('Analysing performance…');
}

async function startAssessment() {
  if (isRecording) return;

  clearRecordingState();
  setStatus('Requesting microphone access…');
  startButton.disabled = true;
  stopButton.disabled = false;

  try {
    await ensureInputReady();

    mediaChunks = [];
    mediaRecorder = new MediaRecorder(mediaStream, {
      mimeType: MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : undefined,
    });

    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) mediaChunks.push(event.data);
    };

    mediaRecorder.onstop = () => {
      const blob = new Blob(mediaChunks, { type: mediaChunks[0]?.type || 'audio/webm' });
      const objectUrl = URL.createObjectURL(blob);
      playbackEl.src = objectUrl;
      analysePerformance();
      setStatus('Done. Play back the recording and inspect the highlighted notes below.');
      maybeReleaseMicrophone();
    };

    const tempo = Number(tempoInput.value);
    expectedTimeline = buildTimeline(tempo);
    renderExpectedNotes(expectedTimeline.map(() => ({ label: 'Listening…' })));

    const totalBeats = COUNT_IN_BEATS + SCALE.length;
    const beatDuration = 60 / tempo;
    const totalDurationSeconds = PRE_ROLL_SECONDS + totalBeats * beatDuration + POST_ROLL_SECONDS;

    analysisFrames = [];
    livePitchHistory = [];
    setStatus(`Count-in starting… then play one note per beat: ${SCALE.map((note) => note.name).join(' ')}.`);
    mediaRecorder.start();
    isRecording = true;
    scheduleMetronome(totalBeats, beatDuration);
    startAudioLoop();
    stopTimeoutId = window.setTimeout(finishRecording, totalDurationSeconds * 1000);
  } catch (error) {
    console.error(error);
    setStatus(`Could not start assessment: ${error.message}`);
    startButton.disabled = false;
    stopButton.disabled = true;
    maybeReleaseMicrophone();
  }
}

async function toggleLiveTuner() {
  if (isLiveTunerOn) {
    isLiveTunerOn = false;
    liveTunerButton.textContent = 'Start live tuner';
    liveStateEl.textContent = 'Mic idle.';
    setStatus('Live tuner stopped.');
    maybeReleaseMicrophone();
    return;
  }

  try {
    await ensureInputReady();
    isLiveTunerOn = true;
    livePitchHistory = [];
    liveTunerButton.textContent = 'Stop live tuner';
    liveStateEl.textContent = 'Listening for pitch…';
    setStatus('Live tuner active. Play a note and the app will show the nearest pitch in real time.');
    startAudioLoop();
  } catch (error) {
    console.error(error);
    setStatus(`Could not start live tuner: ${error.message}`);
  }
}

function clearCurrentHighlight() {
  document.querySelectorAll('.note-card.current').forEach((card) => card.classList.remove('current'));
}

function updatePlaybackHighlight() {
  if (!playbackEl.src || !noteResults.length) return;

  clearCurrentHighlight();
  const currentTime = playbackEl.currentTime;
  const currentIndex = noteResults.findIndex(
    (result) => currentTime >= result.expectedStart && currentTime < result.expectedEnd,
  );

  if (currentIndex >= 0) {
    document.querySelector(`[data-note-index="${currentIndex}"]`)?.classList.add('current');
  }

  if (!playbackEl.paused && !playbackEl.ended) {
    playbackHighlightId = requestAnimationFrame(updatePlaybackHighlight);
  }
}

startButton.addEventListener('click', startAssessment);
stopButton.addEventListener('click', finishRecording);
tuningButton.addEventListener('click', async () => {
  await playTone(440, { seconds: 2.5, type: 'sine', gain: 0.16 });
  setStatus('Played A4 tuning note at 440 Hz.');
});
liveTunerButton.addEventListener('click', toggleLiveTuner);

noteGrid.addEventListener('click', async (event) => {
  const playButton = event.target.closest('.note-play');
  if (!playButton) return;
  const frequency = Number(playButton.dataset.frequency);
  const noteName = playButton.dataset.note;
  await playTone(frequency, { seconds: 1.15, type: 'sine', gain: 0.14 });
  setStatus(`Played reference tone for ${noteName}.`);
});

playbackEl.addEventListener('play', () => {
  if (playbackHighlightId) cancelAnimationFrame(playbackHighlightId);
  updatePlaybackHighlight();
});
playbackEl.addEventListener('pause', () => {
  if (playbackHighlightId) cancelAnimationFrame(playbackHighlightId);
  clearCurrentHighlight();
});
playbackEl.addEventListener('ended', () => {
  if (playbackHighlightId) cancelAnimationFrame(playbackHighlightId);
  clearCurrentHighlight();
});

updateLiveIndicator(null, 0);
renderExpectedNotes();
