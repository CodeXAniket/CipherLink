// Interface sounds, synthesized with the Web Audio API: no audio files to load or license.
// Each sound is a few short tones with a quick fade in and a smooth fade out.
const SETTING_KEY = 'cipherlink-sound';

let context = null;
let enabled = readSetting();

function readSetting() {
  try {
    return localStorage.getItem(SETTING_KEY) !== 'off';
  } catch {
    return true;
  }
}

// Browsers only allow audio after the user has interacted with the page, so this is
// called from a click (joining). Sounds before that are silently skipped.
export function unlock() {
  context ??= new AudioContext();
  if (context.state === 'suspended') context.resume();
}

export function isEnabled() {
  return enabled;
}

export function setEnabled(value) {
  enabled = value;
  try {
    localStorage.setItem(SETTING_KEY, value ? 'on' : 'off');
  } catch {
    // Storage blocked: the setting lasts for this visit only.
  }
}

// One tone: `start` and `duration` in seconds; `slideTo` glides the pitch for a sweep effect.
function tone(frequency, start, duration, { type = 'sine', volume = 0.1, slideTo } = {}) {
  if (!enabled || context?.state !== 'running') return;
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  const at = context.currentTime + start;
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, at);
  if (slideTo) oscillator.frequency.exponentialRampToValueAtTime(slideTo, at + duration * 0.7);
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(volume, at + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);
  oscillator.connect(gain).connect(context.destination);
  oscillator.start(at);
  oscillator.stop(at + duration + 0.02);
}

// Short rising blip.
export function sent() {
  tone(620, 0, 0.14, { slideTo: 980, volume: 0.08 });
}

// Soft two-note ding (A5 then D6).
export function received() {
  tone(880, 0, 0.2, { type: 'triangle', volume: 0.12 });
  tone(1175, 0.09, 0.3, { type: 'triangle', volume: 0.1 });
}

// Doorbell-style arpeggio (C5 E5 G5 C6), played twice.
export function request() {
  for (const offset of [0, 1.1]) {
    [523, 659, 784, 1047].forEach((frequency, index) => {
      tone(frequency, offset + index * 0.1, 0.35, { type: 'triangle', volume: 0.1 });
    });
  }
}
