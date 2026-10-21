import { soundCue } from './sound-score.mjs';

const MAX_VOICES = 6;
// Keep the score's relative dynamics, with an audible but bounded output level.
const OUTPUT_GAIN = 3;

export function createSoundRuntime(contextFactory = () => new (globalThis.AudioContext || globalThis.webkitAudioContext)(), onStateChange = () => {}) {
  let context = null;
  let armed = false;
  let muted = false;
  let hidden = false;
  let disposed = false;
  let failed = false;
  let generation = 0;
  let resumePending = null;
  const voices = new Set();
  const lastPlayed = new Map();

  function status() {
    if (muted) return 'muted';
    if (hidden) return 'hidden';
    if (failed || disposed) return 'unavailable';
    if (!armed || !context) return 'idle';
    return context.state === undefined || context.state === 'running' ? 'ready' : 'pending';
  }
  function report() { try { onStateChange(status()); } catch {} }
  function whenReady() { return resumePending || Promise.resolve(status() === 'ready'); }

  function silence() {
    for (const voice of [...voices]) finishVoice(voice);
    lastPlayed.clear();
  }

  function finishVoice(voice) {
    if (!voices.delete(voice)) return;
    try { voice.oscillator.onended = null; } catch {}
    try { voice.oscillator.stop(); } catch {}
    try { voice.oscillator.disconnect(); } catch {}
    try { voice.gain.disconnect(); } catch {}
  }

  function arm() {
    if (disposed) return false;
    const current = ++generation;
    try {
      if (!context || context.state === 'closed') {
        if (context) { silence(); context.onstatechange = null; }
        context = contextFactory();
        if (!context) throw new Error('Audio is unavailable');
        context.onstatechange = report;
      }
      armed = true;
      failed = false;
      resumePending = null;
      if (context.state === 'suspended' || context.state === 'interrupted') {
        const resumed = context.resume?.();
        resumePending = Promise.resolve(resumed).then(() => {
          if (current !== generation) return false;
          failed = context.state !== undefined && context.state !== 'running';
          report();
          return status() === 'ready';
        }, () => {
          if (current !== generation) return false;
          failed = true;
          report();
          return false;
        });
      }
      report();
      return true;
    } catch {
      armed = false;
      failed = true;
      report();
      return false;
    }
  }

  function play(kind, energy = 1, theme = 'classic') {
    if (!armed || !context || disposed || muted || hidden) return;
    if (context.state !== undefined && context.state !== 'running') return;
    try {
      const cue = soundCue(kind, energy, theme);
      if (!cue || !cue.voices.length) return;
      const now = context.currentTime;
      const previous = lastPlayed.get(kind);
      if (previous !== undefined && (now - previous) * 1000 < cue.minIntervalMs) return;
      lastPlayed.set(kind, now);
      for (const spec of cue.voices) {
        while (voices.size >= MAX_VOICES) finishVoice(voices.values().next().value);
        const voice = { oscillator: null, gain: null };
        voices.add(voice);
        voice.oscillator = context.createOscillator();
        voice.gain = context.createGain();
        const { oscillator, gain } = voice;
        oscillator.type = spec.wave;
        oscillator.frequency.setValueAtTime(spec.fromHz, now);
        oscillator.frequency.exponentialRampToValueAtTime(spec.toHz, now + spec.durationMs / 1000);
        const attackEnd = now + Math.min(spec.attackMs, spec.durationMs / 2) / 1000;
        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.linearRampToValueAtTime(Math.min(spec.gain * OUTPUT_GAIN, 0.08), attackEnd);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + spec.durationMs / 1000);
        oscillator.connect(gain);
        gain.connect(context.destination);
        oscillator.onended = () => finishVoice(voice);
        oscillator.start(now);
        oscillator.stop(now + spec.durationMs / 1000);
      }
      return true;
    } catch {
      silence();
      failed = true;
      report();
      return false;
    }
  }

  function stop() {
    generation++;
    armed = false;
    silence();
    report();
  }
  function setMuted(value) {
    muted = !!value;
    if (muted) silence();
    report();
  }
  function setHidden(value) {
    hidden = !!value;
    if (hidden) {
      generation++;
      armed = false;
      silence();
    }
    report();
  }
  function dispose() {
    if (disposed) return;
    silence();
    disposed = true;
    armed = false;
    generation++;
    if (context) context.onstatechange = null;
    try { const closed = context?.close?.(); closed?.catch?.(() => {}); } catch {}
    context = null;
  }

  return { arm, play, stop, setMuted, setHidden, dispose, status, whenReady };
}
