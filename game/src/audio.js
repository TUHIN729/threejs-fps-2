// Procedural sound: every effect is synthesised with WebAudio, so the game ships no
// audio files and makes no network request. The context is created on the first user
// gesture (pointer lock); before that every call is a silent no-op.
export function createAudio() {
  let ctx = null;
  let master = null;
  let noiseBuffer = null;

  function ensure() {
    if (ctx) return true;
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) return false;
      ctx = new AudioContext();
      master = ctx.createGain();
      master.gain.value = 0.32;
      master.connect(ctx.destination);
      const length = Math.floor(ctx.sampleRate * 0.5);
      noiseBuffer = ctx.createBuffer(1, length, ctx.sampleRate);
      const data = noiseBuffer.getChannelData(0);
      for (let i = 0; i < length; i += 1) data[i] = Math.random() * 2 - 1;
    } catch {
      return false;
    }
    return true;
  }

  function noise(duration, filterFreq, gainValue, when = 0) {
    if (!ensure() || ctx.state === 'suspended') return;
    const start = ctx.currentTime + when;
    const source = ctx.createBufferSource();
    source.buffer = noiseBuffer;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = filterFreq;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(gainValue, start);
    gain.gain.exponentialRampToValueAtTime(0.001, start + duration);
    source.connect(filter);
    filter.connect(gain);
    gain.connect(master);
    source.start(start);
    source.stop(start + duration + 0.02);
  }

  function tone(freq, duration, type, gainValue, slideTo = null, when = 0) {
    if (!ensure() || ctx.state === 'suspended') return;
    const start = ctx.currentTime + when;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, start);
    if (slideTo !== null) osc.frequency.exponentialRampToValueAtTime(slideTo, start + duration);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(gainValue, start);
    gain.gain.exponentialRampToValueAtTime(0.001, start + duration);
    osc.connect(gain);
    gain.connect(master);
    osc.start(start);
    osc.stop(start + duration + 0.02);
  }

  return {
    unlock() {
      ensure();
      if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
    },
    // kind: 'pistol' | 'smg' | 'rifle' | 'dmr' — a noise crack plus a low thump.
    shot(kind) {
      const crack = kind === 'dmr' ? 900 : kind === 'rifle' ? 1400 : 2200;
      noise(0.09, crack, kind === 'dmr' ? 0.9 : 0.55);
      tone(kind === 'dmr' ? 110 : 160, 0.08, 'sine', 0.5, 55);
    },
    distantShot() {
      noise(0.12, 700, 0.16);
    },
    reload() {
      tone(900, 0.05, 'square', 0.08);
      tone(620, 0.05, 'square', 0.08, null, 0.12);
    },
    dryClick() {
      tone(1400, 0.03, 'square', 0.06);
    },
    hit() {
      tone(1900, 0.05, 'sine', 0.22, 1500);
    },
    kill() {
      tone(1500, 0.07, 'sine', 0.25, 900);
      tone(2100, 0.09, 'sine', 0.2, 1400, 0.07);
    },
    hurt() {
      noise(0.14, 500, 0.3);
      tone(120, 0.14, 'sine', 0.3, 70);
    },
    bounce() {
      tone(320, 0.06, 'triangle', 0.18, 180);
    },
    explosion() {
      noise(0.9, 320, 1.0);
      tone(70, 0.8, 'sine', 0.8, 30);
    },
    beep(high = false) {
      tone(high ? 1500 : 1050, 0.09, 'sine', 0.22);
    },
    plantTick() {
      tone(1150, 0.05, 'sine', 0.14);
    },
    roundWin() {
      tone(523, 0.16, 'triangle', 0.22);
      tone(659, 0.16, 'triangle', 0.22, null, 0.14);
      tone(784, 0.28, 'triangle', 0.26, null, 0.28);
    },
    roundLose() {
      tone(392, 0.18, 'triangle', 0.2);
      tone(311, 0.3, 'triangle', 0.2, null, 0.16);
    },
    buy() {
      tone(880, 0.06, 'sine', 0.16);
      tone(1320, 0.08, 'sine', 0.16, null, 0.06);
    },
    denied() {
      tone(220, 0.12, 'square', 0.1, 160);
    },
  };
}
