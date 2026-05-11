# Project Context

## Identity
- **Name:** C Major Scale Assessor
- **Mission:** Demonstrate a browser-based, fixed-score performance assessor that grades timing and intonation per note.
- **Target Users:** Music educators, learners, and stakeholders evaluating the POC.

## Technical Context
- Static browser app (HTML, CSS, vanilla JS modules)
- Browser microphone capture via Web Audio + MediaRecorder
- GitHub Pages-compatible frontend

## Constraints
- POC supports exactly one predefined monophonic score
- Strict fixed tempo grid with four-click count-in
- No backend, no arbitrary sheet-music ingestion, no polyphonic analysis
- Feedback must stay understandable at note level rather than pretending to be examiner-grade scoring
