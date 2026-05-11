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
const scoreSvg = document.getElementById('scoreSvg');
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
const DIATONIC_ORDER = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const LIVE_HISTORY_SIZE = 5;
const LIVE_MIN_RMS = 0.0025;
const SVG_NS = 'http://www.w3.org/2000/svg';

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

function parseNoteName(noteName) {
  const match = /^([A-G])([#b]?)(\d)$/.exec(noteName);
  if (!match) return null;
  return {
    letter: match[1],
    accidental: match[2] || '',
    octave: Number(match[3]),
  };
}

function getStaffStep(noteName) {
  const parsed = parseNoteName(noteName);
  if (!parsed) return 0;
  const referenceIndex = DIATONIC_ORDER.indexOf('E') + 4 * 7;
  const noteIndex = DIATONIC_ORDER.indexOf(parsed.letter) + parsed.octave * 7;
  return noteIndex - referenceIndex;
}

function getScoreAnnotation(result) {
  if (!result?.state || result.state === 'pass') return [];
  if (!result.detected) return ['Missed'];

  const notes = [];
  if (result.pitchErrorCents != null && Math.abs(result.pitchErrorCents) > Number(pitchToleranceInput.value)) {
    notes.push(`${result.pitchErrorCents > 0 ? 'Sharp' : 'Flat'} ${Math.round(Math.abs(result.pitchErrorCents))}c`);
  }
  if (result.timingErrorMs != null && Math.abs(result.timingErrorMs) > Number(timingToleranceInput.value)) {
    notes.push(`${result.timingErrorMs > 0 ? 'Late' : 'Early'} ${Math.round(Math.abs(result.timingErrorMs))}ms`);
  }
  return notes;
}

function formatDurationLabel(durationBeats = 1) {
  if (durationBeats === 0.5) return 'eighth note';
  if (durationBeats === 1) return 'quarter note';
  if (durationBeats === 1.5) return 'dotted quarter';
  if (durationBeats === 2) return 'half note';
  if (durationBeats === 4) return 'whole note';
  return `${durationBeats} beats`;
}

function createSvgNode(tag, attributes = {}, textContent = null) {
  const node = document.createElementNS(SVG_NS, tag);
  Object.entries(attributes).forEach(([key, value]) => {
    if (value != null) node.setAttribute(key, String(value));
  });
  if (textContent != null) node.textContent = textContent;
  return node;
}

function renderScore(results = []) {
  scoreSvg.innerHTML = '';
  const scoreNotes = expectedTimeline.length ? expectedTimeline : SCALE;

  const width = 920;
  const height = 280;
  const left = 92;
  const right = 860;
  const top = 72;
  const lineGap = 22;
  const bottom = top + lineGap * 4;
  const totalBeats = scoreNotes.reduce((sum, note) => sum + (note.durationBeats ?? 1), 0);
  const innerWidth = right - left;
  const beatWidth = innerWidth / totalBeats;

  scoreSvg.appendChild(createSvgNode('rect', { x: 0, y: 0, width, height, rx: 24, class: 'score-bg' }));

  for (let line = 0; line < 5; line += 1) {
    const y = top + line * lineGap;
    scoreSvg.appendChild(createSvgNode('line', { x1: left - 18, y1: y, x2: right + 18, y2: y, class: 'staff-line' }));
  }

  scoreSvg.appendChild(createSvgNode('text', { x: 42, y: top + lineGap * 3.2, class: 'score-clef' }, '𝄞'));
  scoreSvg.appendChild(createSvgNode('text', { x: 74, y: top + lineGap * 1.55, class: 'score-time' }, '4'));
  scoreSvg.appendChild(createSvgNode('text', { x: 74, y: top + lineGap * 3.55, class: 'score-time' }, '4'));

  for (let beat = 4; beat <= totalBeats; beat += 4) {
    const x = left + beat * beatWidth;
    scoreSvg.appendChild(createSvgNode('line', { x1: x, y1: top - 8, x2: x, y2: bottom + 8, class: 'bar-line' }));
  }

  let beatCursor = 0;
  scoreNotes.forEach((note, index) => {
    const step = getStaffStep(note.name);
    const durationBeats = note.durationBeats ?? 1;
    const x = left + (beatCursor + durationBeats / 2) * beatWidth;
    const y = bottom - step * (lineGap / 2);
    const result = results[index] || {};
    const annotationLines = getScoreAnnotation(result);
    const parsed = parseNoteName(note.name);
    const group = createSvgNode('g', {
      class: `score-note ${result.state || 'pending'}`,
      'data-note-index': index,
    });

    group.appendChild(
      createSvgNode('ellipse', {
        cx: x,
        cy: y,
        rx: 11,
        ry: 8,
        class: `notehead ${durationBeats >= 2 ? 'notehead-open' : 'notehead-filled'}`,
      }),
    );
    group.appendChild(createSvgNode('line', { x1: x + 10, y1: y, x2: x + 10, y2: y - 44, class: 'stem' }));

    if (parsed?.accidental) {
      group.appendChild(createSvgNode('text', { x: x - 24, y: y + 6, class: 'score-accidental' }, parsed.accidental === 'b' ? '♭' : '♯'));
    }

    if (step <= -1) {
      for (let ledgerStep = -2; ledgerStep >= step; ledgerStep -= 2) {
        const ledgerY = bottom - ledgerStep * (lineGap / 2);
        group.appendChild(createSvgNode('line', { x1: x - 18, y1: ledgerY, x2: x + 18, y2: ledgerY, class: 'ledger-line' }));
      }
    }

    group.appendChild(createSvgNode('text', { x, y: bottom + 34, class: 'score-note-label' }, note.name));

    annotationLines.forEach((line, annotationIndex) => {
      group.appendChild(
        createSvgNode(
          'text',
          {
            x,
            y: top - 18 - annotationIndex * 18,
            class: `score-annotation ${result.state || 'pending'}`,
          },
          line,
        ),
      );
    });

    scoreSvg.appendChild(group);
    beatCursor += durationBeats;
  });
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
          <p class="sub">Target ${note.frequency.toFixed(2)} Hz · ${formatDurationLabel(note.durationBeats)}</p>
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
  analyser.fftSize = 8192;
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

  const pitch = estimatePitch(analysisBuffer, audioContext.sampleRate, {
    minRms: isLiveTunerOn ? LIVE_MIN_RMS : MIN_RMS,
    clarityThreshold: isLiveTunerOn ? 0.28 : 0.42,
  });
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
  renderScore();
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
  renderScore(noteResults);
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

    const scoreBeats = expectedTimeline.reduce((sum, note) => sum + (note.durationBeats ?? 1), 0);
    const totalBeats = COUNT_IN_BEATS + scoreBeats;
    const beatDuration = 60 / tempo;
    const totalDurationSeconds = PRE_ROLL_SECONDS + totalBeats * beatDuration + POST_ROLL_SECONDS;

    analysisFrames = [];
    livePitchHistory = [];
    setStatus(`Count-in starting… then play the displayed 4/4 melody in time.`);
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
  document.querySelectorAll('.score-note.current').forEach((note) => note.classList.remove('current'));
}

function updatePlaybackHighlight() {
  if (!playbackEl.src || !noteResults.length) return;

  clearCurrentHighlight();
  const currentTime = playbackEl.currentTime;
  const currentIndex = noteResults.findIndex(
    (result) => currentTime >= result.expectedStart && currentTime < result.expectedEnd,
  );

  if (currentIndex >= 0) {
    document.querySelector(`.note-card[data-note-index="${currentIndex}"]`)?.classList.add('current');
    document.querySelector(`.score-note[data-note-index="${currentIndex}"]`)?.classList.add('current');
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
renderScore();
