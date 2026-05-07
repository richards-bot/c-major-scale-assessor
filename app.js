const SCALE = [
  { name: 'C4', frequency: 261.63 },
  { name: 'D4', frequency: 293.66 },
  { name: 'E4', frequency: 329.63 },
  { name: 'F4', frequency: 349.23 },
  { name: 'G4', frequency: 392.0 },
  { name: 'A4', frequency: 440.0 },
  { name: 'B4', frequency: 493.88 },
  { name: 'C5', frequency: 523.25 },
];

const COUNT_IN_BEATS = 4;
const PRE_ROLL_SECONDS = 0.2;
const POST_ROLL_SECONDS = 0.55;
const MIN_RMS = 0.012;
const MIN_VALID_PITCH_HZ = 70;
const MAX_VALID_PITCH_HZ = 1200;
const PITCH_WINDOW_CENTS = 180;

const tempoInput = document.getElementById('tempo');
const pitchToleranceInput = document.getElementById('pitchTolerance');
const timingToleranceInput = document.getElementById('timingTolerance');
const startButton = document.getElementById('startButton');
const stopButton = document.getElementById('stopButton');
const statusEl = document.getElementById('status');
const noteGrid = document.getElementById('noteGrid');
const summaryEl = document.getElementById('summary');
const playbackEl = document.getElementById('playback');

let audioContext;
let analyser;
let analysisBuffer;
let mediaRecorder;
let mediaStream;
let mediaChunks = [];
let analysisFrames = [];
let expectedTimeline = [];
let noteResults = [];
let analysisStartedAt = 0;
let rafId = null;
let stopTimeoutId = null;
let isRecording = false;
let playbackHighlightId = null;

function renderExpectedNotes(results = []) {
  noteGrid.innerHTML = '';
  SCALE.forEach((note, index) => {
    const result = results[index] || {};
    const card = document.createElement('article');
    card.className = `note-card ${result.state || ''}`.trim();
    card.dataset.noteIndex = String(index);

    const pitchText =
      result.pitchErrorCents == null
        ? '—'
        : `${Math.round(result.pitchErrorCents)} cents ${result.pitchErrorCents >= 0 ? 'sharp' : 'flat'}`;
    const timingText =
      result.timingErrorMs == null
        ? '—'
        : `${Math.round(result.timingErrorMs)} ms ${result.timingErrorMs >= 0 ? 'late' : 'early'}`;

    card.innerHTML = `
      <h3>${index + 1}. ${note.name}</h3>
      <p class="sub">Target ${note.frequency.toFixed(2)} Hz · one beat</p>
      <dl>
        <dt>Pitch</dt>
        <dd>${pitchText}</dd>
        <dt>Timing</dt>
        <dd>${timingText}</dd>
        <dt>Status</dt>
        <dd>${result.label || 'Waiting to record'}</dd>
      </dl>
    `;

    noteGrid.appendChild(card);
  });
}

function setStatus(message) {
  statusEl.textContent = message;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function centsOff(targetHz, actualHz) {
  return 1200 * Math.log2(actualHz / targetHz);
}

function autoCorrelate(buffer, sampleRate) {
  let rms = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    rms += buffer[i] * buffer[i];
  }
  rms = Math.sqrt(rms / buffer.length);
  if (rms < MIN_RMS) return null;

  let trimStart = 0;
  let trimEnd = buffer.length - 1;
  const threshold = 0.2;

  while (trimStart < buffer.length / 2 && Math.abs(buffer[trimStart]) < threshold) trimStart += 1;
  while (trimEnd > trimStart && Math.abs(buffer[trimEnd]) < threshold) trimEnd -= 1;

  const trimmed = buffer.slice(trimStart, trimEnd + 1);
  if (trimmed.length < 32) return null;

  const correlations = new Array(trimmed.length).fill(0);
  for (let lag = 0; lag < trimmed.length; lag += 1) {
    let sum = 0;
    for (let i = 0; i < trimmed.length - lag; i += 1) {
      sum += trimmed[i] * trimmed[i + lag];
    }
    correlations[lag] = sum;
  }

  let bestLag = -1;
  let bestCorrelation = -Infinity;
  for (let lag = 8; lag < trimmed.length / 2; lag += 1) {
    if (correlations[lag] > bestCorrelation) {
      bestCorrelation = correlations[lag];
      bestLag = lag;
    }
  }

  if (bestLag <= 0) return null;

  const prev = correlations[bestLag - 1] || 0;
  const current = correlations[bestLag] || 0;
  const next = correlations[bestLag + 1] || 0;
  const denom = prev - 2 * current + next;
  const shift = denom === 0 ? 0 : 0.5 * (prev - next) / denom;
  const frequency = sampleRate / (bestLag + shift);

  if (frequency < MIN_VALID_PITCH_HZ || frequency > MAX_VALID_PITCH_HZ) return null;
  return frequency;
}

function classifyNote(result, pitchTolerance, timingTolerance) {
  if (!result.detected) {
    return { state: 'missed', label: 'Missed / no stable note detected' };
  }

  const pitchOk = result.pitchErrorCents != null && Math.abs(result.pitchErrorCents) <= pitchTolerance;
  const timingOk = result.timingErrorMs != null && Math.abs(result.timingErrorMs) <= timingTolerance;

  if (pitchOk && timingOk) {
    return { state: 'pass', label: 'In tune and in time' };
  }

  if (pitchOk || timingOk) {
    return {
      state: 'partial',
      label: pitchOk ? 'In tune, timing off' : 'In time, tuning off',
    };
  }

  return { state: 'fail', label: 'Out of tune and out of time' };
}

function buildTimeline(tempo) {
  const beatDuration = 60 / tempo;
  const performanceStart = PRE_ROLL_SECONDS + COUNT_IN_BEATS * beatDuration;

  return SCALE.map((note, index) => ({
    ...note,
    index,
    expectedStart: performanceStart + index * beatDuration,
    expectedEnd: performanceStart + (index + 1) * beatDuration,
    beatDuration,
  }));
}

function stopTracks() {
  if (mediaStream) {
    mediaStream.getTracks().forEach((track) => track.stop());
  }
  mediaStream = null;
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
    const gainAmount = isDownBeat ? 0.22 : 0.16;

    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();

    oscillator.type = 'square';
    oscillator.frequency.setValueAtTime(frequency, when);
    gainNode.gain.setValueAtTime(0.0001, when);
    gainNode.gain.exponentialRampToValueAtTime(gainAmount, when + 0.002);
    gainNode.gain.exponentialRampToValueAtTime(0.0001, when + 0.06);

    oscillator.connect(gainNode);
    gainNode.connect(audioContext.destination);
    oscillator.start(when);
    oscillator.stop(when + 0.07);
  }
}

function collectAnalysisFrame() {
  if (!isRecording) return;

  analyser.getFloatTimeDomainData(analysisBuffer);

  let rms = 0;
  for (let i = 0; i < analysisBuffer.length; i += 1) {
    rms += analysisBuffer[i] * analysisBuffer[i];
  }
  rms = Math.sqrt(rms / analysisBuffer.length);

  const pitch = autoCorrelate(analysisBuffer, audioContext.sampleRate);
  const relativeTime = audioContext.currentTime - analysisStartedAt;

  analysisFrames.push({
    time: relativeTime,
    rms,
    pitch,
  });

  rafId = requestAnimationFrame(collectAnalysisFrame);
}

function analysePerformance() {
  const pitchTolerance = Number(pitchToleranceInput.value);
  const timingTolerance = Number(timingToleranceInput.value);
  const beatDuration = expectedTimeline[0]?.beatDuration || 0.8;

  noteResults = expectedTimeline.map((expected, index) => {
    const windowStart = index === 0 ? expected.expectedStart - beatDuration * 0.25 : expected.expectedStart - beatDuration * 0.18;
    const windowEnd = expected.expectedEnd + beatDuration * 0.22;
    const frames = analysisFrames.filter(
      (frame) => frame.time >= windowStart && frame.time <= windowEnd && frame.pitch != null && frame.rms >= MIN_RMS,
    );

    const closeFrames = frames.filter(
      (frame) => Math.abs(centsOff(expected.frequency, frame.pitch)) <= PITCH_WINDOW_CENTS,
    );

    const onsetFrame = closeFrames.find((frame) => frame.time >= expected.expectedStart - beatDuration * 0.12);
    const sustainFrames = closeFrames.filter(
      (frame) => frame.time >= expected.expectedStart + beatDuration * 0.18 && frame.time <= expected.expectedEnd - beatDuration * 0.1,
    );
    const analysisFramesForPitch = sustainFrames.length >= 2 ? sustainFrames : closeFrames;
    const centsValues = analysisFramesForPitch.map((frame) => centsOff(expected.frequency, frame.pitch));
    const pitchErrorCents = median(centsValues);
    const timingErrorMs = onsetFrame ? (onsetFrame.time - expected.expectedStart) * 1000 : null;
    const detected = closeFrames.length > 1;

    const baseResult = {
      noteName: expected.name,
      expectedStart: expected.expectedStart,
      expectedEnd: expected.expectedEnd,
      pitchErrorCents,
      timingErrorMs,
      detected,
      voicedSamples: closeFrames.length,
    };

    return {
      ...baseResult,
      ...classifyNote(baseResult, pitchTolerance, timingTolerance),
    };
  });

  const passCount = noteResults.filter((result) => result.state === 'pass').length;
  const partialCount = noteResults.filter((result) => result.state === 'partial').length;
  const failCount = noteResults.length - passCount - partialCount;
  const meanPitch = median(
    noteResults.filter((result) => result.pitchErrorCents != null).map((result) => Math.abs(result.pitchErrorCents)),
  );
  const meanTiming = median(
    noteResults.filter((result) => result.timingErrorMs != null).map((result) => Math.abs(result.timingErrorMs)),
  );

  summaryEl.textContent = `${passCount}/${noteResults.length} notes fully passed · ${partialCount} partial · ${failCount} failed/missed · median pitch error ${
    meanPitch == null ? '—' : `${Math.round(meanPitch)} cents`
  } · median timing error ${meanTiming == null ? '—' : `${Math.round(meanTiming)} ms`}.`;

  renderExpectedNotes(noteResults);
}

function finishRecording() {
  if (!isRecording) return;
  isRecording = false;

  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }

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
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
      video: false,
    });

    audioContext = audioContext || new AudioContext();
    await audioContext.resume();

    const source = audioContext.createMediaStreamSource(mediaStream);
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.08;
    analysisBuffer = new Float32Array(analyser.fftSize);
    source.connect(analyser);

    mediaChunks = [];
    mediaRecorder = new MediaRecorder(mediaStream, {
      mimeType: MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : undefined,
    });

    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        mediaChunks.push(event.data);
      }
    };

    mediaRecorder.onstop = () => {
      const blob = new Blob(mediaChunks, { type: mediaChunks[0]?.type || 'audio/webm' });
      const objectUrl = URL.createObjectURL(blob);
      playbackEl.src = objectUrl;
      analysePerformance();
      setStatus('Done. Play back the recording and inspect the highlighted notes below.');
      stopTracks();
    };

    const tempo = Number(tempoInput.value);
    expectedTimeline = buildTimeline(tempo);
    renderExpectedNotes(
      expectedTimeline.map(() => ({ state: '', label: 'Listening…', pitchErrorCents: null, timingErrorMs: null })),
    );

    const totalBeats = COUNT_IN_BEATS + SCALE.length;
    const totalDurationSeconds = PRE_ROLL_SECONDS + totalBeats * (60 / tempo) + POST_ROLL_SECONDS;

    setStatus(`Count-in starting… then play one note per beat: ${SCALE.map((note) => note.name).join(' ')}.`);
    mediaRecorder.start();
    isRecording = true;
    scheduleMetronome(totalBeats, 60 / tempo);
    collectAnalysisFrame();
    stopTimeoutId = window.setTimeout(finishRecording, totalDurationSeconds * 1000);
  } catch (error) {
    console.error(error);
    setStatus(`Could not start assessment: ${error.message}`);
    startButton.disabled = false;
    stopButton.disabled = true;
    stopTracks();
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
    const currentCard = document.querySelector(`[data-note-index="${currentIndex}"]`);
    currentCard?.classList.add('current');
  }

  if (!playbackEl.paused && !playbackEl.ended) {
    playbackHighlightId = requestAnimationFrame(updatePlaybackHighlight);
  }
}

startButton.addEventListener('click', startAssessment);
stopButton.addEventListener('click', finishRecording);
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

renderExpectedNotes();
