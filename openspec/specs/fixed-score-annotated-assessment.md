# Spec: Fixed-Score Annotated Assessment POC

**Status:** In progress
**Spec source:** This file (`openspec/specs/fixed-score-annotated-assessment.md`)

---

## Problem

The current POC assesses a fixed ascending C major scale, but the result is presented mainly as cards. Ricky wants the demo to feel more like a music product: show a piece of notated music, give a four-click count-in, let the player perform in time, then annotate each note with timing and intonation issues.

## Solution

Keep the analysis engine constrained and honest:

- one predefined score only
- monophonic treble-clef 4/4 melody with simple rhythmic variation and accidentals
- fixed BPM grid
- four-click count-in
- note-by-note timing and intonation analysis
- annotated score rendering after playback

The score is not arbitrary imported sheet music. It is a known baked-in exercise rendered on a staff in-browser.

## Acceptance Criteria

| # | Criterion |
|---|-----------|
| AC-01 | The UI displays a rendered fixed score before recording starts. |
| AC-02 | Starting assessment gives a four-click count-in before expected performance begins. |
| AC-03 | The app analyses the fixed score note-by-note for timing and intonation using the existing browser-side audio pipeline. |
| AC-04 | After recording, each score note shows an issue annotation when timing or intonation is outside tolerance. |
| AC-05 | Notes without a detected issue remain visually clean or show a pass state rather than a false error. |
| AC-06 | Playback highlights progress through the same notes shown on the rendered score. |
| AC-07 | README explains the new fixed-score scope clearly and does not overclaim arbitrary sheet-music assessment. |

## Assumptions

- The baked-in score for the POC is the existing ascending C major exercise unless explicitly changed later.
- Input is a clean monophonic source.
- Headphones are still recommended to reduce click bleed.
- The app remains a demo-quality assessor, not a conservatoire-grade marking engine.

## Risks and Mitigations

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Visual score looks too fake to read as notation | Medium | Render on a staff with noteheads/stems and simple measure structure rather than plain labels |
| Timing drift causes wrong note-to-note mapping | Medium | Keep one fixed piece and a strict beat grid; avoid arbitrary score following |
| Users assume general sheet music upload is supported | High | State fixed-score-only scope in UI and README |
| Pitch detection is unstable on noisy input | Medium | Preserve current tuner guidance and use tolerant note annotations |

## Non-Goals

- Arbitrary MusicXML/PDF ingestion
- Polyphonic or chord assessment
- Rubato or expressive tempo tracking
- Slurs, grace notes, ornaments, tuplets, repeats, or dynamic marking assessment
- Formal scoring/export for exam use
