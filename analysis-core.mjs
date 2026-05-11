export const SCALE = [
  { name: 'E4', midi: 64, frequency: 329.63, durationBeats: 1, measure: 1 },
  { name: 'F#4', midi: 66, frequency: 369.99, durationBeats: 1, measure: 1 },
  { name: 'G4', midi: 67, frequency: 392.0, durationBeats: 2, measure: 1 },
  { name: 'A4', midi: 69, frequency: 440.0, durationBeats: 1, measure: 2 },
  { name: 'G#4', midi: 68, frequency: 415.3, durationBeats: 1, measure: 2 },
  { name: 'A4', midi: 69, frequency: 440.0, durationBeats: 1, measure: 2 },
  { name: 'B4', midi: 71, frequency: 493.88, durationBeats: 1, measure: 2 },
  { name: 'C5', midi: 72, frequency: 523.25, durationBeats: 2, measure: 3 },
  { name: 'A4', midi: 69, frequency: 440.0, durationBeats: 1, measure: 3 },
  { name: 'F#4', midi: 66, frequency: 369.99, durationBeats: 1, measure: 3 },
  { name: 'E4', midi: 64, frequency: 329.63, durationBeats: 1, measure: 4 },
  { name: 'D4', midi: 62, frequency: 293.66, durationBeats: 1, measure: 4 },
  { name: 'C4', midi: 60, frequency: 261.63, durationBeats: 2, measure: 4 },
];

export const COUNT_IN_BEATS = 4;
export const PRE_ROLL_SECONDS = 0.2;
export const POST_ROLL_SECONDS = 0.55;
export const MIN_RMS = 0.006;
export const MIN_VALID_PITCH_HZ = 70;
export const MAX_VALID_PITCH_HZ = 1200;

export function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

export function centsOff(targetHz, actualHz) {
  return 1200 * Math.log2(actualHz / targetHz);
}

export function nearestNoteName(frequency) {
  if (!Number.isFinite(frequency) || frequency <= 0) return null;
  const midi = Math.round(69 + 12 * Math.log2(frequency / 440));
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const octave = Math.floor(midi / 12) - 1;
  const name = names[((midi % 12) + 12) % 12];
  return `${name}${octave}`;
}

export function estimatePitch(buffer, sampleRate, options = {}) {
  const minHz = options.minHz ?? MIN_VALID_PITCH_HZ;
  const maxHz = options.maxHz ?? MAX_VALID_PITCH_HZ;
  const minRms = options.minRms ?? MIN_RMS;
  const clarityThreshold = options.clarityThreshold ?? 0.55;

  let rms = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    rms += buffer[i] * buffer[i];
  }
  rms = Math.sqrt(rms / buffer.length);
  if (rms < minRms) return null;

  let start = 0;
  let end = buffer.length - 1;
  const trimThreshold = 0.03;

  while (start < buffer.length / 2 && Math.abs(buffer[start]) < trimThreshold) start += 1;
  while (end > start && Math.abs(buffer[end]) < trimThreshold) end -= 1;

  const trimmed = buffer.slice(start, end + 1);
  const size = trimmed.length;
  if (size < 32) return null;

  const minLag = Math.max(2, Math.floor(sampleRate / maxHz));
  const maxLag = Math.min(size - 2, Math.floor(sampleRate / minHz));
  if (maxLag <= minLag) return null;

  let energy = 0;
  for (let i = 0; i < size; i += 1) {
    energy += trimmed[i] * trimmed[i];
  }
  if (!energy) return null;

  const correlations = new Float32Array(maxLag + 2);
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let sum = 0;
    for (let i = 0; i < size - lag; i += 1) {
      sum += trimmed[i] * trimmed[i + lag];
    }
    correlations[lag] = sum;
  }

  let valley = minLag;
  while (valley < maxLag - 1 && correlations[valley] > correlations[valley + 1]) {
    valley += 1;
  }

  let bestLag = -1;
  let bestCorrelation = -Infinity;
  for (let lag = valley; lag <= maxLag; lag += 1) {
    if (correlations[lag] > bestCorrelation) {
      bestCorrelation = correlations[lag];
      bestLag = lag;
    }
  }

  if (bestLag < 0 || !Number.isFinite(bestCorrelation)) return null;

  const normalizedClarity = bestCorrelation / energy;
  if (normalizedClarity < clarityThreshold) return null;

  const left = correlations[bestLag - 1] || correlations[bestLag];
  const center = correlations[bestLag];
  const right = correlations[bestLag + 1] || correlations[bestLag];
  const denom = left - 2 * center + right;
  const shift = denom === 0 ? 0 : 0.5 * (left - right) / denom;
  const lag = bestLag + shift;
  const frequency = sampleRate / lag;

  if (!Number.isFinite(frequency) || frequency < minHz || frequency > maxHz) return null;
  return frequency;
}

export function classifyNote(result, pitchTolerance, timingTolerance) {
  if (!result.detected) {
    return { state: 'missed', label: 'Missed / no stable note detected' };
  }

  const pitchOk = result.pitchErrorCents != null && Math.abs(result.pitchErrorCents) <= pitchTolerance;
  const timingOk = result.timingErrorMs != null && Math.abs(result.timingErrorMs) <= timingTolerance;

  if (pitchOk && timingOk) return { state: 'pass', label: 'In tune and in time' };
  if (pitchOk || timingOk) {
    return {
      state: 'partial',
      label: pitchOk ? 'In tune, timing off' : 'In time, tuning off',
    };
  }

  return { state: 'fail', label: 'Out of tune and out of time' };
}

export function buildTimeline(tempo) {
  const beatDuration = 60 / tempo;
  const performanceStart = PRE_ROLL_SECONDS + COUNT_IN_BEATS * beatDuration;
  let beatCursor = 0;

  return SCALE.map((note, index) => {
    const durationBeats = note.durationBeats ?? 1;
    const timelineNote = {
      ...note,
      index,
      durationBeats,
      expectedStart: performanceStart + beatCursor * beatDuration,
      expectedEnd: performanceStart + (beatCursor + durationBeats) * beatDuration,
      beatDuration,
      measure: note.measure ?? Math.floor(beatCursor / 4) + 1,
      beatOffset: beatCursor,
    };

    beatCursor += durationBeats;
    return timelineNote;
  });
}

export function analyseFrames({ analysisFrames, expectedTimeline, pitchTolerance, timingTolerance, onsetRms = 0.009 }) {
  const beatDuration = expectedTimeline[0]?.beatDuration || 0.8;

  const noteResults = expectedTimeline.map((expected, index) => {
    const previousExpected = index > 0 ? expectedTimeline[index - 1] : null;
    const timingWindow = analysisFrames.filter(
      (frame) =>
        frame.time >= expected.expectedStart - beatDuration * 0.18 &&
        frame.time <= expected.expectedStart + beatDuration * 0.45,
    );

    let onsetFrame = timingWindow.find((frame) => {
      if (frame.rms < onsetRms || frame.pitch == null) return false;
      const currentDistance = Math.abs(centsOff(expected.frequency, frame.pitch));
      if (!previousExpected) return currentDistance <= 160;
      const previousDistance = Math.abs(centsOff(previousExpected.frequency, frame.pitch));
      return currentDistance <= 160 && currentDistance <= previousDistance;
    });

    if (!onsetFrame) {
      onsetFrame = timingWindow.find(
        (frame) => frame.time >= expected.expectedStart && frame.rms >= onsetRms && frame.pitch != null,
      );
    }

    const sustainWindow = analysisFrames.filter(
      (frame) =>
        frame.time >= expected.expectedStart + beatDuration * 0.12 &&
        frame.time <= expected.expectedEnd - beatDuration * 0.08 &&
        frame.rms >= MIN_RMS &&
        frame.pitch != null,
    );

    const widenedWindow = analysisFrames.filter(
      (frame) =>
        frame.time >= expected.expectedStart &&
        frame.time <= expected.expectedEnd &&
        frame.rms >= MIN_RMS &&
        frame.pitch != null,
    );

    const pitchFrames = sustainWindow.length >= 2 ? sustainWindow : widenedWindow;
    const pitchValues = pitchFrames.map((frame) => frame.pitch);
    const detectedFrequency = median(pitchValues);
    const pitchErrorCents = detectedFrequency ? centsOff(expected.frequency, detectedFrequency) : null;
    const timingErrorMs = onsetFrame ? (onsetFrame.time - expected.expectedStart) * 1000 : null;
    const detected = pitchFrames.length >= 2;

    const baseResult = {
      noteName: expected.name,
      expectedStart: expected.expectedStart,
      expectedEnd: expected.expectedEnd,
      detectedFrequency,
      detectedNoteName: detectedFrequency ? nearestNoteName(detectedFrequency) : null,
      pitchErrorCents,
      timingErrorMs,
      detected,
      voicedSamples: pitchFrames.length,
    };

    return {
      ...baseResult,
      ...classifyNote(baseResult, pitchTolerance, timingTolerance),
    };
  });

  const passCount = noteResults.filter((result) => result.state === 'pass').length;
  const partialCount = noteResults.filter((result) => result.state === 'partial').length;
  const failCount = noteResults.length - passCount - partialCount;
  const medianPitchError = median(
    noteResults.filter((result) => result.pitchErrorCents != null).map((result) => Math.abs(result.pitchErrorCents)),
  );
  const medianTimingError = median(
    noteResults.filter((result) => result.timingErrorMs != null).map((result) => Math.abs(result.timingErrorMs)),
  );

  return {
    noteResults,
    summary: {
      passCount,
      partialCount,
      failCount,
      medianPitchError,
      medianTimingError,
    },
  };
}
