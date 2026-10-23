/*
 * Training mode: adaptive ABX identification of distortion types.
 *
 * Each round picks two distortion types. A and B are the sound processed with
 * each of them (labelled); X is secretly one of the two. The listener says
 * which. Every distortion type has its own intensity, adjusted with a
 * 2-down/1-up staircase: two correct answers in a row involving a type make it
 * subtler, any mistake makes both types in the round stronger again. That rule
 * settles where the listener is right about 71% of the time, i.e. right at the
 * edge of what they can currently hear.
 *
 * Relies on globals from app.js: EFFECTS, audio, buffers, SAMPLES, userFile,
 * mode, ensureAudio().
 */

'use strict';

const Trainer = (() => {
  const STORE_KEY = 'distortion-ear-trainer/training-v1';
  const START_LEVEL = 0.9;
  const MIN_LEVEL = 0.02;
  const MAX_LEVEL = 1;
  const DOWN = 0.8;    // multiplier after two correct in a row (subtler)
  const UP = 1.25;     // multiplier after a mistake (stronger)
  const NEEDED = 2;    // correct-in-a-row needed to step down

  const fxById = Object.fromEntries(EFFECTS.map((fx) => [fx.id, fx]));

  // ----------------------------------------------------------- state

  let prog = load();
  const session = { rounds: 0, correct: 0, streak: 0 };
  let trial = null;      // current round
  let lastPair = '';
  let lastSound = '';
  let player = { src: null, gain: null, cond: null, token: 0 };

  function freshProgress() {
    const p = { levels: {}, run: {}, stats: {}, pool: EFFECTS.map((fx) => fx.id), sound: 'random' };
    for (const fx of EFFECTS) {
      p.levels[fx.id] = START_LEVEL;
      p.run[fx.id] = 0;
      p.stats[fx.id] = { n: 0, ok: 0 };
    }
    return p;
  }

  function load() {
    const p = freshProgress();
    try {
      const saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
      if (saved) {
        for (const fx of EFFECTS) {
          if (typeof saved.levels?.[fx.id] === 'number') p.levels[fx.id] = saved.levels[fx.id];
          if (typeof saved.run?.[fx.id] === 'number') p.run[fx.id] = saved.run[fx.id];
          if (saved.stats?.[fx.id]) p.stats[fx.id] = saved.stats[fx.id];
        }
        if (Array.isArray(saved.pool)) {
          const pool = saved.pool.filter((id) => fxById[id]);
          if (pool.length >= 2) p.pool = pool;
        }
        if (typeof saved.sound === 'string') p.sound = saved.sound;
      }
    } catch (_) { /* storage unavailable or corrupt: start fresh */ }
    return p;
  }

  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(prog)); } catch (_) { /* ignore */ }
  }

  // ---------------------------------------------------------- rounds

  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

  function readyBuiltins() {
    return SAMPLES.filter((s) => buffers.has(s.id));
  }

  function chooseSound() {
    if (prog.sound === 'file' && userFile) return { id: 'file', label: `📂 ${userFile.name}`, buffer: userFile.buffer };
    const fixed = SAMPLES.find((s) => s.id === prog.sound);
    if (fixed && buffers.has(fixed.id)) return { id: fixed.id, label: `${fixed.icon} ${fixed.name}`, buffer: buffers.get(fixed.id) };
    const ready = readyBuiltins();
    if (!ready.length) return null;
    const options = ready.length > 1 ? ready.filter((s) => s.id !== lastSound) : ready;
    const s = pick(options);
    return { id: s.id, label: `${s.icon} ${s.name}`, buffer: buffers.get(s.id) };
  }

  function choosePair() {
    const pool = prog.pool.slice();
    for (let tries = 0; tries < 20; tries++) {
      const a = pick(pool);
      const b = pick(pool.filter((id) => id !== a));
      const key = [a, b].sort().join('|');
      if (key !== lastPair || pool.length <= 2) { lastPair = key; return [a, b]; }
    }
    return [pool[0], pool[1]];
  }

  function newTrial() {
    const sound = chooseSound();
    if (!sound) { trial = null; renderTrial(); return; }   // samples still rendering
    lastSound = sound.id;
    const [a, b] = choosePair();
    trial = {
      A: { id: a, amt: prog.levels[a] },
      B: { id: b, amt: prog.levels[b] },
      x: Math.random() < 0.5 ? 'A' : 'B',
      sound,
      answered: null,
      heard: new Set(),
    };
    session.rounds++;
    renderTrial();
  }

  function effectsFor(cond) {
    const fx = {};
    for (const e of EFFECTS) fx[e.id] = { on: false, amt: 0 };
    if (!trial || cond === 'orig') return fx;
    const side = cond === 'X' ? trial[trial.x] : trial[cond];
    fx[side.id] = { on: true, amt: side.amt };
    return fx;
  }

  function answer(choice) {
    if (!trial || trial.answered) return;
    trial.answered = choice;
    const ok = choice === trial.x;
    session.correct += ok ? 1 : 0;
    session.streak = ok ? session.streak + 1 : 0;

    const changes = [];
    for (const side of [trial.A, trial.B]) {
      const id = side.id;
      prog.stats[id].n++;
      if (ok) {
        prog.stats[id].ok++;
        prog.run[id]++;
        if (prog.run[id] >= NEEDED) {
          prog.run[id] = 0;
          const before = prog.levels[id];
          prog.levels[id] = Math.max(MIN_LEVEL, before * DOWN);
          if (prog.levels[id] < before) changes.push({ id, dir: 'down' });
        }
      } else {
        prog.run[id] = 0;
        const before = prog.levels[id];
        prog.levels[id] = Math.min(MAX_LEVEL, before * UP);
        if (prog.levels[id] > before) changes.push({ id, dir: 'up' });
      }
    }
    save();
    renderTrial(ok, changes);
    renderProgress();
  }

  // -------------------------------------------------------- playback

  async function play(cond) {
    if (!trial) return;
    await ensureAudio();
    const ctx = audio.ctx;
    const token = ++player.token;
    const hadOld = fadeOut();
    if (hadOld) await new Promise((r) => setTimeout(r, 40));
    if (token !== player.token || mode !== 'train' || !trial) return;

    // reset the DSP so every replay of a condition starts identically
    audio.node.port.postMessage({ type: 'bypass', value: false });
    audio.node.port.postMessage({ type: 'reset', effects: effectsFor(cond) });

    const src = ctx.createBufferSource();
    src.buffer = trial.sound.buffer;
    src.loop = true;
    const g = ctx.createGain();
    src.connect(g).connect(audio.node);
    src.onended = () => g.disconnect();
    src.start(ctx.currentTime + 0.02);
    player = { ...player, src, gain: g, cond };
    trial.heard.add(cond);
    renderButtons();
  }

  function fadeOut() {
    if (!player.src) return false;
    const t = audio.ctx.currentTime;
    player.gain.gain.setTargetAtTime(0, t, 0.006);
    try { player.src.stop(t + 0.035); } catch (_) { /* already stopped */ }
    player.src = null;
    player.cond = null;
    return true;
  }

  function stop() {
    player.token++;
    fadeOut();
    renderButtons();
  }

  // -------------------------------------------------------------- UI

  const $ = (sel) => document.querySelector(sel);
  const pct = (v) => `${Math.round(v * 100)}%`;

  function renderButtons() {
    document.querySelectorAll('.abx-btn').forEach((btn) => {
      btn.classList.toggle('playing', btn.dataset.play === player.cond);
      btn.disabled = !trial;
    });
  }

  function renderTrial(ok, changes) {
    renderScore();
    const fb = $('#t-feedback');
    const next = $('#t-next');
    const answers = document.querySelectorAll('.answer');
    document.querySelectorAll('.abx-btn').forEach((b) => b.classList.remove('was-x'));

    if (!trial) {
      $('#t-name-A').textContent = '—';
      $('#t-name-B').textContent = '—';
      $('#t-amt-A').textContent = '';
      $('#t-amt-B').textContent = '';
      $('#t-sound').textContent = 'Preparing sounds…';
      answers.forEach((b) => { b.disabled = true; b.className = 'answer'; });
      fb.hidden = true; next.hidden = true;
      renderButtons();
      return;
    }

    $('#t-round').textContent = `Round ${session.rounds}`;
    $('#t-sound').textContent = trial.sound.label;
    for (const side of ['A', 'B']) {
      const fx = fxById[trial[side].id];
      const btn = $(`.abx-btn[data-play="${side}"]`);
      $(`#t-name-${side}`).textContent = fx.name;
      $(`#t-amt-${side}`).textContent = `intensity ${pct(trial[side].amt)}`;
      btn.title = fx.blurb;
    }

    if (!trial.answered) {
      $('#t-name-X').textContent = 'Which one?';
      $('#t-x-sub').textContent = 'mystery';
      answers.forEach((b) => { b.disabled = false; b.className = 'answer'; });
      fb.hidden = true; next.hidden = true;
    } else {
      const xFx = fxById[trial[trial.x].id];
      $('#t-name-X').textContent = xFx.name;
      $('#t-x-sub').textContent = `was ${trial.x}`;
      $(`.abx-btn[data-play="${trial.x}"]`).classList.add('was-x');
      answers.forEach((b) => {
        b.disabled = true;
        b.className = 'answer';
        if (b.dataset.answer === trial.x) b.classList.add('right');
        else if (b.dataset.answer === trial.answered) b.classList.add('wrong');
      });
      if (ok !== undefined) {
        const verdict = ok ? '✓ Correct' : '✗ Not quite';
        const notes = (changes || []).map(({ id, dir }) =>
          `${fxById[id].name} ${dir === 'down' ? '↓ now subtler' : '↑ now stronger'} (${pct(prog.levels[id])})`);
        fb.className = `feedback ${ok ? 'ok' : 'bad'}`;
        fb.innerHTML = `<strong>${verdict}</strong> — X was <strong>${trial.x}</strong>: ${xFx.name}.`
          + (notes.length ? `<br><span class="changes">${notes.join(' · ')}</span>` : '')
          + `<br><span class="changes">Keep comparing A, B and X as long as you like.</span>`;
        fb.hidden = false;
      }
      next.hidden = false;
      next.focus({ preventScroll: true });
    }
    renderButtons();
  }

  function renderScore() {
    const s = session;
    const answered = trial && trial.answered ? s.rounds : s.rounds - 1;
    $('#t-score').textContent = answered > 0
      ? `Session ${s.correct}/${answered}${s.streak >= 3 ? ` · 🔥 ${s.streak} in a row` : ''}`
      : '';
  }

  function renderProgress() {
    const wrap = $('#t-progress');
    wrap.innerHTML = '';
    for (const fx of EFFECTS) {
      const id = fx.id;
      const st = prog.stats[id];
      const inPool = prog.pool.includes(id);
      const row = document.createElement('label');
      row.className = `prog-row${inPool ? '' : ' off'}`;
      row.title = fx.blurb;
      row.innerHTML = `
        <input type="checkbox" ${inPool ? 'checked' : ''}>
        <span class="prog-name">${fx.name}</span>
        <span class="prog-bar"><span style="width:${pct(prog.levels[id])}"></span></span>
        <span class="prog-num">${pct(prog.levels[id])}</span>
        <span class="prog-acc">${st.n ? `${st.ok}/${st.n}` : '—'}</span>`;
      const cb = row.querySelector('input');
      cb.addEventListener('change', () => {
        if (cb.checked) {
          prog.pool.push(id);
        } else if (prog.pool.length <= 2) {
          cb.checked = true;   // ABX needs at least two candidates
          return;
        } else {
          prog.pool = prog.pool.filter((p) => p !== id);
        }
        row.classList.toggle('off', !cb.checked);
        save();
      });
      wrap.appendChild(row);
    }
  }

  function renderSoundSelect() {
    const sel = $('#t-sound-select');
    const opts = [['random', '🎲 Random built-in sound each round'],
      ...SAMPLES.map((s) => [s.id, `${s.icon} ${s.name}`])];
    if (userFile) opts.push(['file', `📂 ${userFile.name}`]);
    sel.innerHTML = opts.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
    if (prog.sound === 'file' && !userFile) prog.sound = 'random';
    sel.value = prog.sound;
  }

  // --------------------------------------------------------- hooks

  function enter() {
    renderSoundSelect();
    renderProgress();
    if (!trial) newTrial(); else renderTrial();
  }

  function onKey(ev) {
    const k = ev.key.toLowerCase();
    if (ev.code === 'Space') { ev.preventDefault(); stop(); return; }
    if (k === 'o' || k === 'a' || k === 'b' || k === 'x') {
      play(k === 'o' ? 'orig' : k.toUpperCase());
    } else if (k === '1') {
      answer('A');
    } else if (k === '2') {
      answer('B');
    } else if ((k === 'enter' || k === 'n') && trial && trial.answered) {
      ev.preventDefault();
      goNext();
    }
  }

  function goNext() {
    stop();
    newTrial();
  }

  function init() {
    document.querySelectorAll('.abx-btn').forEach((btn) =>
      btn.addEventListener('click', () => {
        if (player.cond === btn.dataset.play) stop(); else play(btn.dataset.play);
      }));
    document.querySelectorAll('.answer').forEach((btn) =>
      btn.addEventListener('click', () => answer(btn.dataset.answer)));
    $('#t-next').addEventListener('click', goNext);
    $('#t-sound-select').addEventListener('change', (ev) => {
      prog.sound = ev.target.value;
      save();
      if (trial && !trial.answered && trial.heard.size === 0) { session.rounds--; newTrial(); }
    });
    $('#t-reset').addEventListener('click', () => {
      if (!confirm('Reset all distortion levels and statistics?')) return;
      const sound = prog.sound;
      prog = freshProgress();
      prog.sound = sound;
      save();
      stop();
      session.rounds = 0; session.correct = 0; session.streak = 0;
      newTrial();
      renderProgress();
    });
    renderTrial();
  }

  init();

  return {
    enter,
    stop,
    onKey,
    onSampleReady() {
      if (mode === 'train' && !trial) newTrial();
    },
    onUserFile() {
      renderSoundSelect();
    },
  };
})();
