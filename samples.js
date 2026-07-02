/*
 * Built-in sound bites, synthesized with OfflineAudioContext so the app
 * ships no audio assets. Each entry's make() returns a Promise<AudioBuffer>.
 */

'use strict';

const SAMPLE_RATE = 44100;

function makeNoiseBuffer(ctx, dur) {
  const buf = ctx.createBuffer(1, Math.ceil(dur * ctx.sampleRate), ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

async function renderSample(dur, build) {
  const ctx = new OfflineAudioContext(1, Math.ceil(dur * SAMPLE_RATE), SAMPLE_RATE);
  build(ctx);
  const buf = await ctx.startRendering();
  // normalize to a common peak and fade edges for click-free looping
  const d = buf.getChannelData(0);
  let peak = 0;
  for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]));
  const g = peak > 0 ? 0.6 / peak : 1;
  for (let i = 0; i < d.length; i++) d[i] *= g;
  const fade = Math.min(400, d.length >> 2);
  for (let i = 0; i < fade; i++) {
    d[i] *= i / fade;
    d[d.length - 1 - i] *= i / fade;
  }
  return buf;
}

// ------------------------------------------------------------ helpers

function envGain(ctx, t, attack, level, decayTo, decayEnd) {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(level, t + attack);
  g.gain.exponentialRampToValueAtTime(decayTo, decayEnd);
  g.connect(ctx.destination);
  return g;
}

function addVibrato(ctx, osc, rate, depthHz, start) {
  const lfo = ctx.createOscillator();
  lfo.frequency.value = rate;
  const lg = ctx.createGain();
  lg.gain.value = depthHz;
  lfo.connect(lg).connect(osc.frequency);
  lfo.start(start);
  return lfo;
}

// ------------------------------------------------------- instruments

function buildDrums(ctx) {
  const noise = makeNoiseBuffer(ctx, 0.3);
  const kick = (t) => {
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(150, t);
    o.frequency.exponentialRampToValueAtTime(45, t + 0.12);
    const g = ctx.createGain();
    g.gain.setValueAtTime(1, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
    o.connect(g).connect(ctx.destination);
    o.start(t); o.stop(t + 0.32);
  };
  const snare = (t) => {
    const s = ctx.createBufferSource();
    s.buffer = noise;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass'; f.frequency.value = 1800; f.Q.value = 0.7;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.7, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
    s.connect(f).connect(g).connect(ctx.destination);
    s.start(t); s.stop(t + 0.2);
    const o = ctx.createOscillator();
    o.frequency.value = 190;
    const g2 = ctx.createGain();
    g2.gain.setValueAtTime(0.4, t);
    g2.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
    o.connect(g2).connect(ctx.destination);
    o.start(t); o.stop(t + 0.12);
  };
  const hat = (t, open) => {
    const s = ctx.createBufferSource();
    s.buffer = noise;
    const f = ctx.createBiquadFilter();
    f.type = 'highpass'; f.frequency.value = 7000;
    const g = ctx.createGain();
    const dur = open ? 0.22 : 0.05;
    g.gain.setValueAtTime(0.28, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    s.connect(f).connect(g).connect(ctx.destination);
    s.start(t); s.stop(t + dur + 0.02);
  };
  kick(0.01); kick(0.75); kick(1.0); kick(1.75);
  snare(0.5); snare(1.5);
  for (let i = 0; i < 8; i++) hat(0.01 + i * 0.25, i === 7);
}

function buildMarimba(ctx) {
  const notes = [523.25, 659.25, 783.99, 1046.5, 783.99];
  const partials = [[1, 1, 0.6], [3.9, 0.4, 0.25], [9.2, 0.15, 0.1]];
  notes.forEach((f, n) => {
    const t = 0.01 + n * 0.42;
    for (const [ratio, amp, dec] of partials) {
      const o = ctx.createOscillator();
      o.frequency.value = f * ratio;
      const g = ctx.createGain();
      g.gain.setValueAtTime(amp, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.15 + dec * 2.5);
      o.connect(g).connect(ctx.destination);
      o.start(t); o.stop(t + 0.9);
    }
  });
}

function buildPiano(ctx) {
  const note = (f, t, dur) => {
    for (let k = 1; k <= 6; k++) {
      const o = ctx.createOscillator();
      o.frequency.value = f * k * (1 + 0.0004 * k * k);
      const g = ctx.createGain();
      const amp = 0.9 / Math.pow(k, 1.4);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(amp, t + 0.006);
      g.gain.exponentialRampToValueAtTime(0.001, t + dur / Math.sqrt(k));
      o.connect(g).connect(ctx.destination);
      o.start(t); o.stop(t + dur + 0.05);
    }
  };
  note(220, 0.01, 1.4);
  note(277.18, 0.7, 1.4);
  note(329.63, 1.4, 1.4);
  note(220, 2.1, 1.6);
  note(277.18, 2.1, 1.6);
  note(329.63, 2.1, 1.6);
}

function buildViolin(ctx) {
  const note = (f, t, dur) => {
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = f;
    addVibrato(ctx, o, 5.5, f * 0.011, t);
    const filt = ctx.createBiquadFilter();
    filt.type = 'lowpass'; filt.frequency.value = 2800; filt.Q.value = 1;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.5, t + 0.25);
    g.gain.setValueAtTime(0.5, t + dur - 0.3);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(filt).connect(g).connect(ctx.destination);
    o.start(t); o.stop(t + dur + 0.05);
  };
  note(440, 0.01, 1.75);
  note(659.25, 1.7, 1.75);
}

function buildFlute(ctx) {
  const noise = makeNoiseBuffer(ctx, 3.2);
  const note = (f, t, dur) => {
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = f;
    addVibrato(ctx, o, 5, f * 0.006, t);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.5, t + 0.12);
    g.gain.setValueAtTime(0.5, t + dur - 0.15);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(ctx.destination);
    o.start(t); o.stop(t + dur + 0.05);
    // breath noise around the fundamental
    const s = ctx.createBufferSource();
    s.buffer = noise;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = f; bp.Q.value = 4;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.0001, t);
    ng.gain.exponentialRampToValueAtTime(0.06, t + 0.1);
    ng.gain.exponentialRampToValueAtTime(0.001, t + dur);
    s.connect(bp).connect(ng).connect(ctx.destination);
    s.start(t); s.stop(t + dur + 0.05);
  };
  note(783.99, 0.01, 1.5);
  note(987.77, 1.5, 1.45);
}

function buildVoice(ctx) {
  const o = ctx.createOscillator();
  o.type = 'sawtooth';
  o.frequency.setValueAtTime(125, 0);
  o.frequency.linearRampToValueAtTime(115, 2.9);
  addVibrato(ctx, o, 5, 4, 0);
  // "ah" vowel formants
  const formants = [[700, 1.0, 8], [1200, 0.5, 10], [2600, 0.22, 12]];
  const master = ctx.createGain();
  master.gain.setValueAtTime(0.0001, 0);
  master.gain.exponentialRampToValueAtTime(1, 0.2);
  master.gain.setValueAtTime(1, 2.5);
  master.gain.exponentialRampToValueAtTime(0.001, 2.95);
  master.connect(ctx.destination);
  for (const [f, amp, q] of formants) {
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = f; bp.Q.value = q;
    const g = ctx.createGain();
    g.gain.value = amp;
    o.connect(bp).connect(g).connect(master);
  }
  o.start(0); o.stop(3);
}

function buildSynthLead(ctx) {
  const notes = [440, 493.88, 554.37, 659.25, 554.37, 493.88, 440, 329.63];
  const delay = ctx.createDelay(0.5);
  delay.delayTime.value = 0.28;
  const fb = ctx.createGain();
  fb.gain.value = 0.3;
  delay.connect(fb).connect(delay);
  const wet = ctx.createGain();
  wet.gain.value = 0.35;
  delay.connect(wet).connect(ctx.destination);
  notes.forEach((f, n) => {
    const t = 0.01 + n * 0.24;
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.value = f;
    const filt = ctx.createBiquadFilter();
    filt.type = 'lowpass'; filt.frequency.value = 3000;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.35, t);
    g.gain.exponentialRampToValueAtTime(0.02, t + 0.22);
    o.connect(filt).connect(g);
    g.connect(ctx.destination);
    g.connect(delay);
    o.start(t); o.stop(t + 0.23);
  });
}

function buildSynthBass(ctx) {
  const notes = [55, 55, 82.41, 55, 73.42, 55, 98, 73.42];
  notes.forEach((f, n) => {
    const t = 0.01 + n * 0.25;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = f;
    const filt = ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.Q.value = 6;
    filt.frequency.setValueAtTime(1400, t);
    filt.frequency.exponentialRampToValueAtTime(130, t + 0.22);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.6, t);
    g.gain.exponentialRampToValueAtTime(0.05, t + 0.24);
    o.connect(filt).connect(g).connect(ctx.destination);
    o.start(t); o.stop(t + 0.25);
  });
}

// -------------------------------------------------------------- list

const SAMPLES = [
  { id: 'drums', name: 'Drum loop', icon: '🥁', dur: 2.0, build: buildDrums },
  { id: 'marimba', name: 'Marimba', icon: '🪘', dur: 2.6, build: buildMarimba },
  { id: 'piano', name: 'Piano', icon: '🎹', dur: 3.8, build: buildPiano },
  { id: 'violin', name: 'Violin', icon: '🎻', dur: 3.6, build: buildViolin },
  { id: 'flute', name: 'Flute', icon: '🪈', dur: 3.1, build: buildFlute },
  { id: 'voice', name: 'Voice “ah”', icon: '🗣️', dur: 3.0, build: buildVoice },
  { id: 'lead', name: 'Synth lead', icon: '🎛️', dur: 2.6, build: buildSynthLead },
  { id: 'bass', name: 'Synth bass', icon: '🔊', dur: 2.0, build: buildSynthBass },
];

function makeSample(entry) {
  return renderSample(entry.dur, entry.build);
}
