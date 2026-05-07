export const SCALE = [
  { name: 'C4', frequency: 261.63 },
  { name: 'D4', frequency: 293.66 },
  { name: 'E4', frequency: 329.63 },
  { name: 'F4', frequency: 349.23 },
  { name: 'G4', frequency: 392.0 },
  { name: 'A4', frequency: 440.0 },
  { name: 'B4', frequency: 493.88 },
  { name: 'C5', frequency: 523.25 },
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

  let rms = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    rms += buffer[i] * buffer[i];
  }
  rms = Math.sqrt(rms / buffer.length);
  if (rms < minRms) return null;

  const minLag = Math.max(2, Math.floor(sampleRate / maxHz));
  const maxLag = Math.min(buffer.length - 2, Math.floor(sampleRate / minHz));

  let bestLag = -1;
  let bestScore = -Infinity;

  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let ac = 0;
    let sumA = 0;
    let sumB = 0;
    const frameLength = buffer.length - lag;

    for (let i = 0; i < frameLength; i += 1) {
      const a = buffer[i];
      const b = buffer[i + lag];
      ac += a * b;
      sumA += a * a;
      sumB += b * b;
    }

    const denom = Math.sqrt(sumA * sumB);
    if (!denom) continue;
    const score = ac / denom;

    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }

  if (bestLag < 0 || bestScore < 0.82) return null;

  const correlationAt = (lag) => {
    let ac = 0;
    let sumA = 0;
    let sumB = 0;
    const frameLength = buffer.length - lag;

    for (let i = 0; i < frameLength; i += 1) {
      const a = buffer[i];
      const b = buffer[i + lag];
      ac += a * b;
      sumA += a * a;
      sumB += b * b;
    }

    const denom = Math.sqrt(sumA * sumB);
    return denom ? ac / denom : 0;
  };

  const left = correlationAt(bestLag - 1);
  const center = correlationAt(bestLag);
  const right = correlationAt(bestLag + 1);
  const denom = left - 2 * center + right;
  const shift = denom === 0 ? 0 : 0.5 * (left - right) / denom;
  const frequency = sampleRate / (bestLag + shift);

  if (frequency < minHz || frequency > maxHz) return null;
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

  return SCALE.map((note, index) => ({
    ...note,
    index,
    expectedStart: performanceStart + index * beatDuration,
    expectedEnd: performanceStart + (index + 1) * beatDuration,
    beatDuration,
  }));
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
