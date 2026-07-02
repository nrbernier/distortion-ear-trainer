/*
 * UI + audio engine. The processing itself lives in worklet.js.
 */

'use strict';

const EFFECTS = [
  {
    id: 'wow', name: 'Wow & flutter',
    blurb: 'Slow (wow) and fast (flutter) pitch fluctuations caused by playback-speed variations in analog media such as tape and vinyl. Listen for a seasick, warbling pitch.',
    wiki: 'https://en.wikipedia.org/wiki/Wow_and_flutter_measurement',
  },
  {
    id: 'srate', name: 'Sample rate reduction',
    blurb: 'Resampling to a lower rate without anti-alias filtering folds high frequencies back down as inharmonic aliasing — a metallic, ring-y sheen unrelated to the original pitch.',
    wiki: 'https://en.wikipedia.org/wiki/Aliasing',
  },
  {
    id: 'bits', name: 'Bit depth reduction',
    blurb: 'Fewer amplitude levels per sample raise the quantization-noise floor. Mild settings add a fuzzy hiss correlated with the signal; extreme settings sound crunchy and gated.',
    wiki: 'https://en.wikipedia.org/wiki/Quantization_(signal_processing)',
  },
  {
    id: 'codec', name: 'Lossy codec artifacts',
    blurb: 'Perceptual codecs (MP3, AAC…) discard spectral detail judged inaudible. At low bitrates this produces swirly, watery “musical noise”, smeared transients and reduced bandwidth. Simulated here with spectral gating and quantization.',
    wiki: 'https://en.wikipedia.org/wiki/Compression_artifact',
  },
  {
    id: 'soft', name: 'Soft clipping (saturation)',
    blurb: 'Gradual waveshaping that rounds off peaks, adding mostly low-order harmonics. The “warm” overdrive of tape and tube circuits; at higher levels it becomes a thick fuzz.',
    wiki: 'https://en.wikipedia.org/wiki/Distortion_(music)',
  },
  {
    id: 'hard', name: 'Hard clipping',
    blurb: 'Abrupt flat-topping of the waveform once it exceeds a ceiling — the sound of digital overload. Harsh, buzzy, with dense high-order harmonics.',
    wiki: 'https://en.wikipedia.org/wiki/Clipping_(audio)',
  },
  {
    id: 'ring', name: 'Ring modulation',
    blurb: 'Multiplying the signal by a carrier tone replaces the original frequencies with sums and differences, producing inharmonic, bell-like or robotic tones (a form of intermodulation).',
    wiki: 'https://en.wikipedia.org/wiki/Ring_modulation',
  },
  {
    id: 'trem', name: 'Amplitude wobble (tremolo)',
    blurb: 'Periodic fluctuation of loudness at a few hertz. Compare with wow & flutter, which wobbles pitch instead of level.',
    wiki: 'https://en.wikipedia.org/wiki/Tremolo',
  },
  {
    id: 'comb', name: 'Comb filtering',
    blurb: 'Mixing a signal with a short delayed copy of itself carves evenly spaced notches into the spectrum — a hollow, phasey, “in a pipe” coloration.',
    wiki: 'https://en.wikipedia.org/wiki/Comb_filter',
  },
  {
    id: 'lp', name: 'Bandwidth limiting',
    blurb: 'A low-pass filter removes high frequencies, making the sound muffled or telephone-like. Common in old recordings, small speakers and low-bandwidth transmission.',
    wiki: 'https://en.wikipedia.org/wiki/Low-pass_filter',
  },
  {
    id: 'comp', name: 'Over-compression',
    blurb: 'Heavy dynamic range compression squashes transients and makes the level “pump” and “breathe”, especially audible after loud hits.',
    wiki: 'https://en.wikipedia.org/wiki/Dynamic_range_compression',
  },
  {
    id: 'drop', name: 'Dropouts',
    blurb: 'Brief random silences, as caused by network packet loss, damaged tape or a failing connection. The slider controls how often they occur.',
    wiki: 'https://en.wikipedia.org/wiki/Packet_loss',
  },
  {
    id: 'hiss', name: 'Noise (hiss)',
    blurb: 'Constant broadband background noise, like tape hiss or a noisy preamp. Unlike quantization noise, it stays at the same level whether or not the signal plays.',
    wiki: 'https://en.wikipedia.org/wiki/Noise_(electronics)',
  },
  {
    id: 'hum', name: 'Mains hum',
    blurb: 'A steady 50/60 Hz tone plus harmonics leaking in from power lines — typically from ground loops or poor shielding. Simulated here at 50 Hz.',
    wiki: 'https://en.wikipedia.org/wiki/Mains_hum',
  },
  {
    id: 'crackle', name: 'Crackle (impulse noise)',
    blurb: 'Random short clicks and pops, like a dusty vinyl record or a bad electrical contact.',
    wiki: 'https://en.wikipedia.org/wiki/Impulse_noise_(acoustics)',
  },
];

const state = {};
for (const fx of EFFECTS) state[fx.id] = { on: false, amt: 0.5 };

const audio = {
  ctx: null,
  node: null,
  gain: null,
  src: null,
  buffer: null,
  playing: false,
  bypass: false,
};

const buffers = new Map(); // sample id -> AudioBuffer
let selectedSample = null;

// ------------------------------------------------------------- audio

async function ensureAudio() {
  if (audio.ctx) {
    if (audio.ctx.state === 'suspended') await audio.ctx.resume();
    return;
  }
  const ctx = new AudioContext();
  await ctx.audioWorklet.addModule('worklet.js');
  const node = new AudioWorkletNode(ctx, 'distortion-chain', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    channelCount: 2,
    channelCountMode: 'explicit',
    channelInterpretation: 'speakers',
    processorOptions: { effects: state, bypass: audio.bypass },
  });
  const gain = ctx.createGain();
  gain.gain.value = parseFloat(document.getElementById('volume').value);
  node.connect(gain).connect(ctx.destination);
  audio.ctx = ctx;
  audio.node = node;
  audio.gain = gain;
  sendParams();
  sendBypass();
}

function sendParams() {
  if (!audio.node) return;
  audio.node.port.postMessage({ type: 'params', effects: state });
}

function sendBypass() {
  if (!audio.node) return;
  audio.node.port.postMessage({ type: 'bypass', value: audio.bypass });
}

function startSource(buffer) {
  stopSource();
  const src = audio.ctx.createBufferSource();
  src.buffer = buffer;
  src.loop = true;
  src.connect(audio.node);
  src.start();
  audio.src = src;
  audio.buffer = buffer;
}

function stopSource() {
  if (audio.src) {
    try { audio.src.stop(); } catch (_) { /* already stopped */ }
    audio.src.disconnect();
    audio.src = null;
  }
}

async function play() {
  if (!audio.buffer && !selectedSample) return;
  await ensureAudio();
  const buffer = audio.buffer || buffers.get(selectedSample);
  if (!buffer) return;
  startSource(buffer);
  audio.playing = true;
  updateTransport();
}

function stop() {
  stopSource();
  audio.playing = false;
  updateTransport();
}

// ---------------------------------------------------------------- UI

function updateTransport() {
  const btn = document.getElementById('play');
  btn.textContent = audio.playing ? '⏹ Stop' : '▶ Play';
  btn.classList.toggle('active', audio.playing);
}

function updateBypassUI() {
  const btn = document.getElementById('bypass');
  btn.classList.toggle('bypassed', audio.bypass);
  btn.querySelector('.state').textContent = audio.bypass ? 'ORIGINAL' : 'DISTORTED';
}

function buildSampleGrid() {
  const grid = document.getElementById('sample-grid');
  for (const entry of SAMPLES) {
    const btn = document.createElement('button');
    btn.className = 'sample';
    btn.dataset.id = entry.id;
    btn.disabled = true;
    btn.innerHTML = `<span class="icon">${entry.icon}</span><span>${entry.name}</span>`;
    btn.addEventListener('click', async () => {
      selectedSample = entry.id;
      audio.buffer = buffers.get(entry.id);
      document.querySelectorAll('.sample').forEach((b) =>
        b.classList.toggle('selected', b === btn));
      if (audio.playing) {
        startSource(audio.buffer);
      } else {
        await play();
      }
    });
    grid.appendChild(btn);
  }
  // generate all buffers in the background (OfflineAudioContext needs no gesture)
  for (const entry of SAMPLES) {
    makeSample(entry).then((buf) => {
      buffers.set(entry.id, buf);
      grid.querySelector(`[data-id="${entry.id}"]`).disabled = false;
    });
  }
}

function buildEffectGrid() {
  const grid = document.getElementById('effect-grid');
  for (const fx of EFFECTS) {
    const card = document.createElement('div');
    card.className = 'effect';
    card.innerHTML = `
      <div class="fx-head">
        <label class="fx-toggle">
          <input type="checkbox" data-fx="${fx.id}">
          <span class="fx-name">${fx.name}</span>
        </label>
        <button class="info" aria-label="About ${fx.name}" title="What is this?">ⓘ</button>
      </div>
      <input type="range" min="0" max="1" step="0.01" value="0.5" data-fx="${fx.id}" disabled>
      <div class="popover hidden">
        <p>${fx.blurb}</p>
        <a href="${fx.wiki}" target="_blank" rel="noopener">Read more on Wikipedia ↗</a>
      </div>`;

    const check = card.querySelector('input[type=checkbox]');
    const slider = card.querySelector('input[type=range]');
    const info = card.querySelector('.info');
    const popover = card.querySelector('.popover');

    check.addEventListener('change', () => {
      state[fx.id].on = check.checked;
      slider.disabled = !check.checked;
      card.classList.toggle('on', check.checked);
      sendParams();
    });
    slider.addEventListener('input', () => {
      state[fx.id].amt = parseFloat(slider.value);
      sendParams();
    });
    info.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const wasHidden = popover.classList.contains('hidden');
      closeAllPopovers();
      popover.classList.toggle('hidden', !wasHidden);
    });
    grid.appendChild(card);
  }
  document.addEventListener('click', (ev) => {
    if (!ev.target.closest('.popover')) closeAllPopovers();
  });
}

function closeAllPopovers() {
  document.querySelectorAll('.popover').forEach((p) => p.classList.add('hidden'));
}

function resetEffects() {
  for (const fx of EFFECTS) {
    state[fx.id].on = false;
    state[fx.id].amt = 0.5;
  }
  document.querySelectorAll('.effect').forEach((card) => {
    card.classList.remove('on');
    card.querySelector('input[type=checkbox]').checked = false;
    const slider = card.querySelector('input[type=range]');
    slider.value = 0.5;
    slider.disabled = true;
  });
  sendParams();
}

// ------------------------------------------------------------ wiring

function init() {
  buildSampleGrid();
  buildEffectGrid();
  updateTransport();
  updateBypassUI();

  document.getElementById('play').addEventListener('click', () => {
    if (audio.playing) stop(); else play();
  });

  document.getElementById('bypass').addEventListener('click', () => {
    audio.bypass = !audio.bypass;
    sendBypass();
    updateBypassUI();
  });

  document.getElementById('volume').addEventListener('input', (ev) => {
    if (audio.gain) audio.gain.gain.value = parseFloat(ev.target.value);
  });

  document.getElementById('reset').addEventListener('click', resetEffects);

  document.getElementById('file-input').addEventListener('change', async (ev) => {
    const file = ev.target.files[0];
    if (!file) return;
    await ensureAudio();
    try {
      const data = await file.arrayBuffer();
      const buf = await audio.ctx.decodeAudioData(data);
      selectedSample = null;
      audio.buffer = buf;
      document.querySelectorAll('.sample').forEach((b) => b.classList.remove('selected'));
      document.getElementById('file-name').textContent = file.name;
      startSource(buf);
      audio.playing = true;
      updateTransport();
    } catch (err) {
      alert(`Could not decode "${file.name}" as audio (${err.message || err}).`);
    }
  });

  document.addEventListener('keydown', (ev) => {
    if (ev.target.matches('input, textarea, select')) return;
    if (ev.code === 'Space') {
      ev.preventDefault();
      if (audio.playing) stop(); else play();
    } else if (ev.key === 'b' || ev.key === 'B') {
      audio.bypass = !audio.bypass;
      sendBypass();
      updateBypassUI();
    }
  });
}

init();
