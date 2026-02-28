// Synthesised sound effects using Web Audio API — no files needed.

let ctx = null;

function getCtx() {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
  }
  return ctx;
}

// Cooldowns to avoid overlapping sounds when many enemies are hit per frame
let lastHurtAt = 0;
let lastDeathAt = 0;
const HURT_COOLDOWN = 0.06; // seconds
const DEATH_COOLDOWN = 0.05;

/**
 * Short percussive "hurt" thud — pitched-down noise burst + low sine thump.
 */
export function playHurt() {
  const ac = getCtx();
  const now = ac.currentTime;
  if (now - lastHurtAt < HURT_COOLDOWN) return;
  lastHurtAt = now;

  // noise burst
  const len = 0.08;
  const buf = ac.createBuffer(1, ac.sampleRate * len, ac.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) {
    data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
  }
  const noise = ac.createBufferSource();
  noise.buffer = buf;

  const nFilt = ac.createBiquadFilter();
  nFilt.type = 'bandpass';
  nFilt.frequency.value = 800;
  nFilt.Q.value = 1.5;

  const nGain = ac.createGain();
  nGain.gain.setValueAtTime(0.18, now);
  nGain.gain.exponentialRampToValueAtTime(0.001, now + len);

  noise.connect(nFilt).connect(nGain).connect(ac.destination);
  noise.start(now);
  noise.stop(now + len);

  // low thump
  const osc = ac.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(120, now);
  osc.frequency.exponentialRampToValueAtTime(50, now + 0.06);

  const oGain = ac.createGain();
  oGain.gain.setValueAtTime(0.2, now);
  oGain.gain.exponentialRampToValueAtTime(0.001, now + 0.08);

  osc.connect(oGain).connect(ac.destination);
  osc.start(now);
  osc.stop(now + 0.1);
}

/**
 * Longer "death" sound — descending tone + crunch noise + sub rumble.
 */
export function playDeath() {
  const ac = getCtx();
  const now = ac.currentTime;
  if (now - lastDeathAt < DEATH_COOLDOWN) return;
  lastDeathAt = now;

  // descending tone
  const osc = ac.createOscillator();
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(400, now);
  osc.frequency.exponentialRampToValueAtTime(60, now + 0.25);

  const oFilt = ac.createBiquadFilter();
  oFilt.type = 'lowpass';
  oFilt.frequency.setValueAtTime(1200, now);
  oFilt.frequency.exponentialRampToValueAtTime(200, now + 0.25);

  const oGain = ac.createGain();
  oGain.gain.setValueAtTime(0.15, now);
  oGain.gain.exponentialRampToValueAtTime(0.001, now + 0.3);

  osc.connect(oFilt).connect(oGain).connect(ac.destination);
  osc.start(now);
  osc.stop(now + 0.35);

  // crunch noise
  const len = 0.12;
  const buf = ac.createBuffer(1, ac.sampleRate * len, ac.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) {
    data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / data.length, 2);
  }
  const noise = ac.createBufferSource();
  noise.buffer = buf;

  const nFilt = ac.createBiquadFilter();
  nFilt.type = 'bandpass';
  nFilt.frequency.value = 1400;
  nFilt.Q.value = 2;

  const nGain = ac.createGain();
  nGain.gain.setValueAtTime(0.22, now);
  nGain.gain.exponentialRampToValueAtTime(0.001, now + len);

  noise.connect(nFilt).connect(nGain).connect(ac.destination);
  noise.start(now);
  noise.stop(now + len);

  // sub rumble
  const sub = ac.createOscillator();
  sub.type = 'sine';
  sub.frequency.setValueAtTime(60, now);
  sub.frequency.exponentialRampToValueAtTime(25, now + 0.2);

  const sGain = ac.createGain();
  sGain.gain.setValueAtTime(0.25, now);
  sGain.gain.exponentialRampToValueAtTime(0.001, now + 0.25);

  sub.connect(sGain).connect(ac.destination);
  sub.start(now);
  sub.stop(now + 0.3);
}
