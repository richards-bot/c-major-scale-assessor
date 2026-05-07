# C Major Scale Assessor

Small proof-of-concept web app for assessing a one-octave C major scale against a metronome.

## What it does

- gives a four-beat metronome count-in
- expects `C4 D4 E4 F4 G4 A4 B4 C5`, one note per beat
- records microphone audio in the browser
- estimates pitch with autocorrelation
- compares each note against the expected target pitch and beat placement
- includes an A4 = 440 Hz tuning note
- lets you play each target note directly from the UI
- flags notes that are out of tune or out of time
- lets you play back the recording and watch the note cards highlight in sequence

## Run locally

```bash
cd /home/rich/.openclaw/workspace/projects/c-major-scale-assessor
node server.js
```

Then open <http://localhost:4173> in a Chromium-based browser and allow microphone access.

## Notes / limitations

- This is intentionally narrow: one scale, one note per beat, fixed tempo grid.
- It works best for monophonic sources with a clean signal.
- Headphones help a lot because click bleed can confuse the pitch detector.
- It uses a pragmatic frame-window approach, not full score following, so it is a POC rather than an examiner-grade assessment engine.
- The analysis is intentionally tuned for this single ascending C major scale exercise.
