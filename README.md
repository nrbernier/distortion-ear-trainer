# Distortion Ear Trainer

A browser-based tool for training your ears to recognize different kinds of
audio distortion and degradation. Pick a sound bite (or load your own audio
file), enable one or more distortion types, vary their intensity with sliders,
and flip the bypass switch to A/B against the clean original.

## Running

AudioWorklets require the page to be served over HTTP (not opened as a
`file://` URL). Any static server works:

```sh
python3 -m http.server 8000
```

Then open <http://localhost:8000> in a recent Chrome or Firefox.

## Features

- **8 built-in sound bites** — drums, marimba, piano, violin, flute, voice,
  synth lead and synth bass — synthesized on the fly with the Web Audio API,
  so there are no audio assets to download.
- **Load your own audio** via the file picker (anything the browser can
  decode: WAV, MP3, OGG, FLAC…).
- **15 distortion types**, stackable in any combination, each with an
  intensity slider and an ⓘ info bubble linking to Wikipedia:
  wow & flutter, sample rate reduction (aliasing), bit depth reduction,
  lossy codec artifacts, soft clipping, hard clipping, ring modulation,
  tremolo, comb filtering, bandwidth limiting, over-compression, dropouts,
  hiss, mains hum and crackle.
- **Bypass switch** (keyboard: `B`) for instant A/B comparison;
  `Space` toggles playback.

All processing happens locally in an `AudioWorklet`
([worklet.js](worklet.js)); nothing is uploaded anywhere.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Page structure |
| `style.css` | Styling |
| `app.js` | UI and audio engine (graph setup, playback, parameter routing) |
| `worklet.js` | All DSP: the ordered distortion chain in an AudioWorkletProcessor |
| `samples.js` | Offline synthesis of the built-in sound bites |
