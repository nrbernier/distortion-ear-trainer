/*
 * Distortion chain AudioWorkletProcessor.
 * All effects are implemented here, in a fixed order, so that multiple
 * distortions can be stacked deterministically. Each effect has a single
 * "amount" in [0,1]; 0 (or disabled) is transparent.
 */

'use strict';

const N = 1024;          // FFT size for the codec simulator
const HOP = N / 2;       // 50% overlap (Hann analysis window satisfies COLA)
const OUTQ_SIZE = 4096;  // ring buffer, must be > N + HOP + 128, power of two
const OUTQ_MASK = OUTQ_SIZE - 1;
const WOW_SIZE = 8192;
const WOW_MASK = WOW_SIZE - 1;
const COMB_SIZE = 1024;
const COMB_MASK = COMB_SIZE - 1;

const IDS = [
  'wow', 'srate', 'bits', 'codec', 'soft', 'hard', 'ring', 'trem',
  'comb', 'lp', 'comp', 'drop', 'hiss', 'hum', 'crackle',
];

// ---------------------------------------------------------------- FFT

function makeFFT(n) {
  const levels = Math.round(Math.log2(n));
  const cosT = new Float32Array(n / 2);
  const sinT = new Float32Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cosT[i] = Math.cos((2 * Math.PI * i) / n);
    sinT[i] = Math.sin((2 * Math.PI * i) / n);
  }
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let j = 0; j < levels; j++) r = (r << 1) | ((i >>> j) & 1);
    rev[i] = r;
  }
  return function fft(re, im, inverse) {
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let size = 2; size <= n; size *= 2) {
      const half = size / 2;
      const step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = i, k = 0; j < i + half; j++, k += step) {
          const c = cosT[k];
          const s = inverse ? sinT[k] : -sinT[k];
          const tre = re[j + half] * c - im[j + half] * s;
          const tim = re[j + half] * s + im[j + half] * c;
          re[j + half] = re[j] - tre;
          im[j + half] = im[j] - tim;
          re[j] += tre;
          im[j] += tim;
        }
      }
    }
    if (inverse) {
      for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
    }
  };
}

const fft = makeFFT(N);

const hann = new Float32Array(N);
for (let i = 0; i < N; i++) hann[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / N));

// ---------------------------------------------------------- processor

class DistortionChain extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const init = (options && options.processorOptions) || {};
    this.bypass = !!init.bypass;
    this.target = {};
    this.cur = {};
    for (const id of IDS) { this.target[id] = 0; this.cur[id] = 0; }
    if (init.effects) {
      for (const id of IDS) {
        const p = init.effects[id];
        if (p) { this.target[id] = p.on ? p.amt : 0; this.cur[id] = this.target[id]; }
      }
    }

    this.chan = [this.makeChannelState(), this.makeChannelState()];

    // shared (channel-linked) oscillator phases
    this.wowP1 = 0; this.wowP2 = 0;
    this.ringPhase = 0;
    this.tremPhase = 0;
    this.humPhase = 0;

    // dropout state machine (linked across channels)
    this.dropGain = 1;
    this.dropTarget = 1;
    this.dropWait = sampleRate;   // samples until next dropout
    this.dropLen = 0;

    // low-pass biquad coefficients (shared, per-channel state)
    this.lpAmt = -1;
    this.lpB0 = 1; this.lpB1 = 0; this.lpB2 = 0; this.lpA1 = 0; this.lpA2 = 0;

    // per-block scratch buffers for shared LFO values
    this.wowMod = new Float32Array(128);
    this.ringS = new Float32Array(128);
    this.tremG = new Float32Array(128);
    this.humS = new Float32Array(128);
    this.dropG = new Float32Array(128);

    this.port.onmessage = (e) => {
      const d = e.data;
      if (d.type === 'params') {
        for (const id of IDS) {
          const p = d.effects[id];
          if (p) this.target[id] = p.on ? p.amt : 0;
        }
      } else if (d.type === 'bypass') {
        this.bypass = !!d.value;
      }
    };
  }

  makeChannelState() {
    return {
      wowBuf: new Float32Array(WOW_SIZE), wowW: 0,
      srPhase: 0, srHold: 0,
      combBuf: new Float32Array(COMB_SIZE), combW: 0,
      lpX1: 0, lpX2: 0, lpY1: 0, lpY2: 0,
      compEnv: 0,
      crackEnv: 0,
      codec: null,
    };
  }

  makeCodecState() {
    return {
      frame: new Float32Array(N),
      hopBuf: new Float32Array(HOP),
      hopFill: 0,
      olap: new Float32Array(N),
      outQ: new Float32Array(OUTQ_SIZE),
      outR: 0,
      outW: N, // primed with N zeros => constant N-sample latency
      re: new Float32Array(N),
      im: new Float32Array(N),
      mag: new Float32Array(N / 2 + 1),
    };
  }

  updateLowpass(amt) {
    if (Math.abs(amt - this.lpAmt) < 0.0005) return;
    this.lpAmt = amt;
    const cutoff = 16000 * Math.pow(320 / 16000, amt);
    const Q = 0.9;
    const w0 = (2 * Math.PI * cutoff) / sampleRate;
    const cw = Math.cos(w0);
    const alpha = Math.sin(w0) / (2 * Q);
    const a0 = 1 + alpha;
    this.lpB0 = ((1 - cw) / 2) / a0;
    this.lpB1 = (1 - cw) / a0;
    this.lpB2 = ((1 - cw) / 2) / a0;
    this.lpA1 = (-2 * cw) / a0;
    this.lpA2 = (1 - alpha) / a0;
  }

  codecFrame(st, amt) {
    const { frame, hopBuf, olap, re, im, mag } = st;
    frame.copyWithin(0, HOP);
    frame.set(hopBuf, N - HOP);
    for (let i = 0; i < N; i++) { re[i] = frame[i] * hann[i]; im[i] = 0; }
    fft(re, im, false);

    let maxMag = 0;
    for (let i = 0; i <= N / 2; i++) {
      const m = Math.hypot(re[i], im[i]);
      mag[i] = m;
      if (m > maxMag) maxMag = m;
    }

    if (maxMag > 0) {
      // Simulated perceptual coding: kill weak bins ("musical noise"),
      // coarsely quantize the survivors, and shave off top-end bandwidth.
      const keepFrac = 1 - 0.8 * amt;
      const cutBin = Math.max(8, Math.floor((N / 2) * keepFrac));
      const thresh = maxMag * Math.pow(10, -4.2 * (1 - amt) - 0.6);
      const q = maxMag * (0.002 + 0.12 * amt * amt);
      for (let i = 1; i < N / 2; i++) {
        const m = mag[i];
        let scale = 0;
        if (i <= cutBin && m >= thresh) {
          const mq = Math.round(m / q) * q;
          scale = mq / m;
        }
        re[i] *= scale; im[i] *= scale;
        re[N - i] = re[i]; im[N - i] = -im[i];
      }
      if (mag[N / 2] < thresh) re[N / 2] = 0;
    }

    fft(re, im, true);
    for (let i = 0; i < N; i++) olap[i] += re[i];
    for (let i = 0; i < HOP; i++) st.outQ[(st.outW + i) & OUTQ_MASK] = olap[i];
    st.outW += HOP;
    olap.copyWithin(0, HOP);
    olap.fill(0, N - HOP);
  }

  codecSample(st, x, amt) {
    st.hopBuf[st.hopFill++] = x;
    if (st.hopFill === HOP) {
      st.hopFill = 0;
      this.codecFrame(st, amt);
    }
    const y = st.outQ[st.outR & OUTQ_MASK];
    st.outR++;
    return y;
  }

  expRand(mean) {
    return -Math.log(1 - Math.random()) * mean;
  }

  process(inputs, outputs) {
    const inp = inputs[0];
    const out = outputs[0];
    const frames = out[0].length;

    if (!inp || inp.length === 0) {
      for (let c = 0; c < out.length; c++) out[c].fill(0);
      return true;
    }

    if (this.bypass) {
      for (let c = 0; c < out.length; c++) out[c].set(inp[c] || inp[0]);
      return true;
    }

    // smooth parameter changes (~10 ms) to avoid zipper noise
    for (const id of IDS) {
      const t = this.target[id];
      this.cur[id] += 0.25 * (t - this.cur[id]);
      if (Math.abs(this.cur[id] - t) < 1e-4) this.cur[id] = t;
    }
    const e = this.cur;

    this.updateLowpass(e.lp);

    // dropout scheduling: if the rate was raised, don't wait out a stale gap
    if (e.drop > 0.001) {
      const meanGap = sampleRate / (0.4 + e.drop * 6);
      if (this.dropWait > 4 * meanGap) this.dropWait = this.expRand(meanGap);
    }

    // ---- shared per-sample signals (identical across channels) ----
    const TWO_PI = 2 * Math.PI;
    for (let i = 0; i < frames; i++) {
      this.wowP1 += (TWO_PI * 0.9) / sampleRate;
      this.wowP2 += (TWO_PI * 6.3) / sampleRate;
      this.wowMod[i] = Math.sin(this.wowP1) * 0.75 + Math.sin(this.wowP2) * 0.25;

      this.ringS[i] = Math.sin(this.ringPhase);
      this.ringPhase += (TWO_PI * 220) / sampleRate;

      this.tremG[i] = 1 - e.trem * 0.5 * (1 + Math.sin(this.tremPhase));
      this.tremPhase += (TWO_PI * 4.5) / sampleRate;

      this.humS[i] =
        Math.sin(this.humPhase) +
        0.45 * Math.sin(2 * this.humPhase + 0.7) +
        0.2 * Math.sin(3 * this.humPhase + 1.3);
      this.humPhase += (TWO_PI * 50) / sampleRate;

      // dropout state machine
      if (this.dropTarget === 1) {
        if (e.drop > 0.001) {
          this.dropWait--;
          if (this.dropWait <= 0) {
            this.dropTarget = 0;
            this.dropLen = sampleRate * (0.02 + Math.random() * 0.1);
          }
        }
      } else {
        this.dropLen--;
        if (this.dropLen <= 0) {
          this.dropTarget = 1;
          this.dropWait = this.expRand(sampleRate / (0.4 + e.drop * 6));
        }
      }
      this.dropGain += (this.dropTarget - this.dropGain) * 0.008;
      this.dropG[i] = this.dropGain;
    }
    if (this.wowP1 > TWO_PI) this.wowP1 -= TWO_PI;
    if (this.wowP2 > TWO_PI) this.wowP2 -= TWO_PI;
    if (this.ringPhase > TWO_PI) this.ringPhase -= TWO_PI;
    if (this.tremPhase > TWO_PI) this.tremPhase -= TWO_PI;
    if (this.humPhase > TWO_PI) this.humPhase -= TWO_PI;

    // makeup gains reference a 0.5-amplitude signal so that enabling the
    // clippers changes timbre without a big loudness jump (a loudness cue
    // would defeat the ear-training purpose)
    const softDrive = e.soft * 12;
    const softNorm = softDrive > 0.001 ? 0.5 / Math.tanh(softDrive * 0.5) : 1;
    const hardGain = 1 + e.hard * 25;
    const hardMakeup = (0.5 / Math.min(1, 0.5 * hardGain)) * Math.pow(1 / hardGain, 0.15);
    const srRate = sampleRate * Math.pow(700 / sampleRate, e.srate);
    const srInc = srRate / sampleRate;
    const bitQ = Math.pow(2, 12 - e.bits * 10.5 - 1);
    const combDelay = Math.floor(sampleRate * 0.0035);
    const compT = Math.pow(10, (-38 * e.comp) / 20);
    const compMakeup = Math.min(6, Math.pow(1 / compT, 0.55));
    const hissG = 0.2 * Math.pow(e.hiss, 2.5);
    const humG = 0.12 * e.hum * e.hum;
    const crackP = 0.0012 * e.crackle * e.crackle;

    const nch = Math.min(out.length, 2);
    for (let c = 0; c < nch; c++) {
      const st = this.chan[c];
      const x = inp[c] || inp[0];
      const y = out[c];

      if (e.codec > 0.001) {
        if (!st.codec) st.codec = this.makeCodecState();
      } else if (st.codec) {
        st.codec = null;
      }

      for (let i = 0; i < frames; i++) {
        let s = x[i];

        // 1. wow & flutter — modulated delay line
        if (e.wow > 0.001) {
          st.wowBuf[st.wowW & WOW_MASK] = s;
          const rp = st.wowW - 600 + this.wowMod[i] * e.wow * 380;
          const i0 = Math.floor(rp);
          const fr = rp - i0;
          s = st.wowBuf[i0 & WOW_MASK] * (1 - fr) + st.wowBuf[(i0 + 1) & WOW_MASK] * fr;
          st.wowW++;
        }

        // 2. sample rate reduction — zero-order hold, no anti-alias filter
        if (e.srate > 0.001) {
          st.srPhase += srInc;
          if (st.srPhase >= 1) { st.srPhase -= 1; st.srHold = s; }
          s = st.srHold;
        }

        // 3. bit depth reduction
        if (e.bits > 0.001) {
          s = Math.round(s * bitQ) / bitQ;
        }

        // 4. lossy codec artifacts (STFT spectral gating + quantization)
        if (st.codec) {
          s = this.codecSample(st.codec, s, e.codec);
        }

        // 5. soft clipping
        if (e.soft > 0.001) {
          s = Math.tanh(s * softDrive) * softNorm;
        }

        // 6. hard clipping
        if (e.hard > 0.001) {
          s = Math.max(-1, Math.min(1, s * hardGain)) * hardMakeup;
        }

        // 7. ring modulation
        if (e.ring > 0.001) {
          s = s * (1 - e.ring) + s * this.ringS[i] * e.ring;
        }

        // 8. tremolo
        if (e.trem > 0.001) {
          s *= this.tremG[i];
        }

        // 9. comb filtering
        if (e.comb > 0.001) {
          st.combBuf[st.combW & COMB_MASK] = s;
          const dl = st.combBuf[(st.combW - combDelay) & COMB_MASK];
          st.combW++;
          s = (s + e.comb * dl) / (1 + 0.4 * e.comb);
        }

        // 10. low-pass (bandwidth limiting)
        if (e.lp > 0.001) {
          const yv = this.lpB0 * s + this.lpB1 * st.lpX1 + this.lpB2 * st.lpX2
            - this.lpA1 * st.lpY1 - this.lpA2 * st.lpY2;
          st.lpX2 = st.lpX1; st.lpX1 = s;
          st.lpY2 = st.lpY1; st.lpY1 = yv;
          s = yv;
        }

        // 11. over-compression
        if (e.comp > 0.001) {
          const a = Math.abs(s);
          const coef = a > st.compEnv ? 0.01 : 0.0004;
          st.compEnv += coef * (a - st.compEnv);
          let g = 1;
          if (st.compEnv > compT) {
            g = (compT + (st.compEnv - compT) / 8) / st.compEnv;
          }
          s *= g * compMakeup;
        }

        // 12. dropouts
        if (e.drop > 0.001) {
          s *= this.dropG[i];
        }

        // 13. hiss
        if (e.hiss > 0.001) {
          s += (Math.random() * 2 - 1) * hissG;
        }

        // 14. mains hum
        if (e.hum > 0.001) {
          s += this.humS[i] * humG;
        }

        // 15. crackle
        if (e.crackle > 0.001) {
          if (Math.random() < crackP) {
            st.crackEnv = Math.random() * 1.6 - 0.8;
          }
          s += st.crackEnv;
          st.crackEnv *= 0.62;
        }

        y[i] = Math.max(-1, Math.min(1, s));
      }
    }
    return true;
  }
}

registerProcessor('distortion-chain', DistortionChain);
