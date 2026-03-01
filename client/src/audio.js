let audioContext = null;

function getAudioContext() {
  if (typeof window === "undefined") {
    return null;
  }

  if (!audioContext) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) {
      return null;
    }

    audioContext = new AudioContextClass();
  }

  return audioContext;
}

export function unlockAudio() {
  const context = getAudioContext();
  if (!context || context.state === "running") {
    return Promise.resolve();
  }

  return context.resume().catch(() => {});
}

function scheduleTone(context, startTime, tone) {
  const oscillator = context.createOscillator();
  const gainNode = context.createGain();
  const duration = tone.duration ?? 0.08;
  const volume = tone.volume ?? 0.03;
  const attack = tone.attack ?? 0.01;
  const release = tone.release ?? duration;

  oscillator.type = tone.type ?? "triangle";
  oscillator.frequency.setValueAtTime(tone.frequency, startTime);
  if (tone.endFrequency) {
    oscillator.frequency.exponentialRampToValueAtTime(
      Math.max(1, tone.endFrequency),
      startTime + duration,
    );
  }

  gainNode.gain.setValueAtTime(0.0001, startTime);
  gainNode.gain.exponentialRampToValueAtTime(volume, startTime + attack);
  gainNode.gain.exponentialRampToValueAtTime(0.0001, startTime + release);

  oscillator.connect(gainNode);
  gainNode.connect(context.destination);
  oscillator.start(startTime);
  oscillator.stop(startTime + duration + 0.04);
}

function playPattern(pattern) {
  const context = getAudioContext();
  if (!context) {
    return;
  }

  const schedulePattern = () => {
    const startTime = context.currentTime + 0.01;
    pattern.forEach((tone) => {
      scheduleTone(context, startTime + (tone.delay ?? 0), tone);
    });
  };

  if (context.state === "suspended") {
    void context.resume().then(schedulePattern).catch(() => {});
    return;
  }

  schedulePattern();
}

export function playSelectSound() {
  playPattern([
    { frequency: 880, duration: 0.03, volume: 0.018, type: "triangle" },
    { delay: 0.025, frequency: 1174, duration: 0.04, volume: 0.02, type: "triangle" },
  ]);
}

export function playMoveSound() {
  playPattern([
    { frequency: 520, duration: 0.025, volume: 0.018, type: "triangle" },
    { delay: 0.02, frequency: 700, duration: 0.055, volume: 0.024, type: "triangle" },
  ]);
}

export function playCaptureSound() {
  playPattern([
    { frequency: 240, endFrequency: 170, duration: 0.05, volume: 0.03, type: "square" },
    { delay: 0.02, frequency: 420, endFrequency: 320, duration: 0.08, volume: 0.024, type: "triangle" },
  ]);
}

export function playInvalidSound() {
  playPattern([
    { frequency: 360, endFrequency: 210, duration: 0.1, volume: 0.022, type: "sawtooth" },
  ]);
}

export function playCheckSound() {
  playPattern([
    { frequency: 740, duration: 0.045, volume: 0.018, type: "triangle" },
    { delay: 0.05, frequency: 1040, duration: 0.08, volume: 0.03, type: "square" },
  ]);
}

export function playMateSound() {
  playPattern([
    { frequency: 660, duration: 0.05, volume: 0.022, type: "triangle" },
    { delay: 0.055, frequency: 554, duration: 0.05, volume: 0.022, type: "triangle" },
    { delay: 0.11, frequency: 440, duration: 0.07, volume: 0.024, type: "triangle" },
    { delay: 0.185, frequency: 330, endFrequency: 220, duration: 0.18, volume: 0.03, type: "square" },
  ]);
}

