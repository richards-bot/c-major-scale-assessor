# Fixed Score Performance Assessor

Small proof-of-concept web app for assessing one predefined treble-clef 4/4 exercise against a metronome.

## What it does

- gives a four-beat metronome count-in
- displays one baked-in score in treble clef / 4/4 with simple rhythmic variation and a couple of accidentals
- records microphone audio in the browser
- estimates pitch with autocorrelation
- compares each note against the expected target pitch and beat placement
- annotates the rendered score with timing and/or intonation issues after playback
- includes an A4 = 440 Hz tuning note
- includes a live pitch monitor showing current note, frequency, cents offset, and input level
- lets you play each target note directly from the UI
- flags notes that are out of tune or out of time
- lets you play back the recording and watch both the score and note cards highlight in sequence

## Run locally

```bash
cd /home/rich/.openclaw/workspace/projects/c-major-scale-assessor
node server.js
```

Then open <http://localhost:4173> in a Chromium-based browser and allow microphone access.

## Notes / limitations

- This is intentionally narrow: one fixed score only, fixed tempo grid, monophonic melody.
- It works best for monophonic sources with a clean signal.
- Headphones help a lot because click bleed can confuse the pitch detector.
- It uses a pragmatic frame-window approach, not full score following, so it is a POC rather than an examiner-grade assessment engine.
- It does **not** support arbitrary sheet-music upload/import or polyphonic assessment.
- The analysis is intentionally tuned for this single baked-in melody.
