// Sound effects, synthesised with the Web Audio API so the page needs no audio files.
//
// Browsers let a page make sound only after the player has interacted with it, so the
// audio context is created on the first press of a pointer or key. Sounds requested
// before that, or while sound is off, are dropped rather than queued, so they never
// play late in a burst. Each sound is scheduled on the audio clock, which keeps it in
// step with its animation even in a background tab, where timers are throttled.

const SETTING = 'cat-and-mouse:sound';

let ctx = null;
let master = null;
let hiss = null;
let crackle = null;
let enabled = readSetting();

function readSetting() {
  try { return JSON.parse(localStorage.getItem(SETTING)) !== false; } catch { return true; }
}

export function isOn() {
  return enabled;
}

export function setOn(on) {
  enabled = on;
  try { localStorage.setItem(SETTING, JSON.stringify(on)); } catch { /* not persisted */ }
}

/**
 * Plays a sound `delay` ms from now. For a moving card, `flight` is the time in ms
 * until it lands: it slides that long, then lands.
 */
export function play(name, delay = 0, flight = 0) {
  if (!enabled || ctx?.state !== 'running') return;
  SOUNDS[name](ctx.currentTime + delay / 1000, flight / 1000);
}

// A suspended context, as after an interruption on a phone, resumes with the next press.
function unlock() {
  if (!ctx) {
    const AudioContext = window.AudioContext ?? window.webkitAudioContext;
    if (!AudioContext) return;
    ctx = new AudioContext();
    master = ctx.createGain();
    master.gain.value = 0.6;
    master.connect(ctx.createDynamicsCompressor()).connect(ctx.destination);
    hiss = hissBuffer();
    crackle = crackleBuffer();
  }
  if (ctx.state === 'suspended') ctx.resume();
}

for (const type of ['pointerdown', 'keydown']) {
  addEventListener(type, unlock, { capture: true, passive: true });
}

function hissBuffer() {
  const buffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}

/**
 * Sparse clicks whose density changes every few milliseconds: the fibres of a sheet
 * of paper giving way one after another, which a smooth hiss alone lacks.
 */
function crackleBuffer() {
  const buffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  const chunk = Math.round(ctx.sampleRate * 0.008);
  let density = 0;
  for (let i = 0; i < data.length; i++) {
    if (i % chunk === 0) density = 0.003 + Math.random() ** 2 * 0.08;
    data[i] = Math.random() < density ? Math.random() * 2 - 1 : 0;
  }
  return buffer;
}

// ---- building blocks --------------------------------------------------------

/** A pitched note that fades out over `decay` seconds, optionally gliding to `to` Hz. */
function tone(at, { freq, to = freq, type = 'sine', gain = 0.2, attack = 0.005, decay = 0.3 }) {
  const osc = ctx.createOscillator();
  const env = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, at);
  if (to !== freq) osc.frequency.exponentialRampToValueAtTime(to, at + attack + decay);
  env.gain.setValueAtTime(0, at);
  env.gain.linearRampToValueAtTime(gain, at + attack);
  env.gain.exponentialRampToValueAtTime(0.0001, at + attack + decay);
  osc.connect(env).connect(master);
  osc.start(at);
  osc.stop(at + attack + decay + 0.05);
}

/**
 * Filtered noise that swells over `attack` and fades over `decay` seconds, while the
 * filter glides from `freq` to `sweep` Hz.
 */
function noise(at, { source = hiss, filter = 'bandpass', freq, sweep = freq, q = 0.8, gain, attack = 0.002, decay }) {
  const src = ctx.createBufferSource();
  const shape = ctx.createBiquadFilter();
  const env = ctx.createGain();
  src.buffer = source;
  shape.type = filter;
  shape.frequency.setValueAtTime(freq, at);
  if (sweep !== freq) shape.frequency.exponentialRampToValueAtTime(sweep, at + attack + decay);
  shape.Q.value = q;
  env.gain.setValueAtTime(0, at);
  env.gain.linearRampToValueAtTime(gain, at + attack);
  env.gain.exponentialRampToValueAtTime(0.0001, at + attack + decay);
  src.connect(shape).connect(env).connect(master);
  // A random stretch of the buffer keeps repeated cards from sounding identical.
  src.start(at, Math.random() * 1.2);
  src.stop(at + attack + decay + 0.02);
}

/**
 * A card sliding through the air and over other cards: hiss and crackle that swell
 * quickly and trail off as the card slows down, brightening as it goes.
 */
function slide(at, length, gain) {
  const attack = length * 0.2;
  const decay = length * 0.8;
  noise(at, { freq: 1600, sweep: 3200, q: 0.6, gain: gain * 0.6, attack, decay });
  noise(at, { source: crackle, freq: 3000, sweep: 5000, q: 0.7, gain: gain * 1.4, attack, decay });
}

/** A card landing flat: a dull pat of the sheet with a crisp edge on top. */
function tap(at, gain) {
  noise(at, { filter: 'lowpass', freq: 1300, q: 0.5, gain, decay: 0.045 });
  noise(at, { source: crackle, filter: 'highpass', freq: 2400, q: 0.5, gain: gain * 1.2, decay: 0.025 });
}

/** A soft bell: a sine with a quieter octave above it. */
function bell(at, freq, gain = 0.16, decay = 0.7) {
  tone(at, { freq, gain, decay });
  tone(at, { freq: freq * 2, gain: gain * 0.3, decay: decay * 0.5 });
}

// A card shown without a flight still slides this long before it lands.
const MIN_FLIGHT = 0.07;

const C5 = 523.25;
const E5 = 659.26;
const G5 = 783.99;
const C6 = 1046.5;

const SOUNDS = {
  // A card laid onto a pile.
  place(at, flight) {
    const length = Math.max(flight, MIN_FLIGHT);
    slide(at, length, 0.22);
    tap(at + length, 0.5);
  },
  // A card taken into the hand: quieter, and it lands softly among the other cards.
  take(at, flight) {
    const length = Math.max(flight, MIN_FLIGHT);
    slide(at, length, 0.16);
    tap(at + length, 0.18);
  },
  pick(at) {
    noise(at, { source: crackle, filter: 'highpass', freq: 3000, gain: 0.4, attack: 0.004, decay: 0.03 });
  },
  joker(at) {
    [C6, E5 * 2, G5 * 2, C6 * 2].forEach((freq, i) => {
      tone(at + i * 0.06, { freq, type: 'triangle', gain: 0.12, decay: 0.4 });
    });
  },
  complete(at) {
    [C5, E5, G5, C6].forEach((freq, i) => {
      tone(at + i * 0.03, { freq, type: 'triangle', gain: 0.09, attack: 0.02, decay: 1.1 });
    });
  },
  // The two halves of the deck riffled into each other, then squared up.
  shuffle(at) {
    for (let i = 0; i < 14; i++) tap(at + i * 0.026, 0.1 + Math.random() * 0.1);
    tap(at + 14 * 0.026 + 0.08, 0.35);
  },
  turn(at) {
    bell(at, G5);
    bell(at + 0.14, C6);
  },
  win(at) {
    [C5, E5, G5].forEach((freq, i) => tone(at + i * 0.12, { freq, type: 'triangle', gain: 0.2, decay: 0.3 }));
    [C5, E5, G5, C6].forEach((freq) => {
      tone(at + 0.36, { freq, type: 'triangle', gain: 0.1, attack: 0.02, decay: 1.4 });
    });
  },
  lose(at) {
    [392, 330, 262].forEach((freq, i) => {
      tone(at + i * 0.2, { freq, to: freq * 0.97, type: 'triangle', gain: 0.16, decay: i === 2 ? 0.9 : 0.4 });
    });
  },
  // A low double bump: that move is not allowed.
  refuse(at) {
    tone(at, { freq: 220, to: 160, type: 'triangle', gain: 0.3, decay: 0.09 });
    tone(at + 0.12, { freq: 200, to: 140, type: 'triangle', gain: 0.3, decay: 0.12 });
  },
};
