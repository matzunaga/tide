(() => {
  "use strict";

  const STATION_ID = "9410170";
  const API_BASE = "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter";
  const REFRESH_MS = 30 * 60 * 1000;

  const canvas = document.getElementById("tideCanvas");
  const context = canvas.getContext("2d", { alpha: false });

  const tideHeight = document.getElementById("tideHeight");
  const tideTrend = document.getElementById("tideTrend");
  const eventLabel = document.getElementById("eventLabel");
  const eventTime = document.getElementById("eventTime");
  const updatedAt = document.getElementById("updatedAt");
  const offlineNotice = document.getElementById("offlineNotice");
  const soundToggle = document.getElementById("soundToggle");
  const soundLabel = document.getElementById("soundLabel");

  const state = {
    width: 0,
    height: 0,
    pixelRatio: 1,
    normalizedHeight: 0.5,
    targetNormalizedHeight: 0.5,
    direction: 1,
    targetDirection: 1,
    energy: 0.28,
    targetEnergy: 0.28,
    lastFrame: performance.now()
  };

  const layers = Array.from({ length: 12 }, (_, index) => ({
    depth: index / 11,
    speed: 0.13 + index * 0.03,
    amplitude: 17 + index * 5,
    wavelength: 155 + index * 34,
    phase: Math.random() * Math.PI * 2,
    opacity: 0.025 + index * 0.008
  }));

  let audioContext = null;
  let noiseSource = null;
  let noiseGain = null;
  let soundOn = false;

  function pad(value) {
    return String(value).padStart(2, "0");
  }

  function todayForNOAA() {
    const now = new Date();
    return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  }

  function noaaURL() {
    const parameters = new URLSearchParams({
      begin_date: todayForNOAA(),
      range: "48",
      station: STATION_ID,
      product: "predictions",
      datum: "MLLW",
      time_zone: "lst_ldt",
      units: "english",
      interval: "h",
      format: "json",
      application: "tide"
    });

    return `${API_BASE}?${parameters.toString()}`;
  }

  function parseNOAATime(value) {
    const [dateText, timeText] = value.split(" ");
    const [year, month, day] = dateText.split("-").map(Number);
    const [hours, minutes] = timeText.split(":").map(Number);

    return new Date(year, month - 1, day, hours, minutes, 0);
  }

  function formatTime(date) {
    return new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      minute: "2-digit"
    }).format(date);
  }

  function setText(element, text) {
    element.textContent = text;
  }

  function fallbackTide(now = new Date()) {
    const cycleMilliseconds = 12.42 * 60 * 60 * 1000;
    const phase = ((now.getTime() % cycleMilliseconds) / cycleMilliseconds) * Math.PI * 2;
    const value = 2.8 + Math.sin(phase) * 2.05;
    const rate = Math.cos(phase);

    return {
      value,
      rate,
      low: 0.75,
      high: 4.85,
      nextTime: new Date(
        now.getTime() +
          ((rate >= 0 ? Math.PI / 2 - phase : (Math.PI * 3) / 2 - phase) + Math.PI * 2) %
            (Math.PI * 2) /
            (Math.PI * 2) *
            cycleMilliseconds
      ),
      nextIsHigh: rate >= 0
    };
  }

  function interpolate(predictions, now) {
    const nowTime = now.getTime();

    for (let index = 0; index < predictions.length - 1; index += 1) {
      const previous = predictions[index];
      const next = predictions[index + 1];

      if (previous.time.getTime() <= nowTime && next.time.getTime() >= nowTime) {
        const span = next.time.getTime() - previous.time.getTime();
        const progress = span === 0 ? 0 : (nowTime - previous.time.getTime()) / span;

        return {
          value: previous.value + (next.value - previous.value) * progress,
          rate: next.value - previous.value
        };
      }
    }

    return {
      value: predictions[0].value,
      rate: 0
    };
  }

  function findNextTurningPoint(predictions, now) {
    const nowTime = now.getTime();

    for (let index = 1; index < predictions.length - 1; index += 1) {
      const previous = predictions[index - 1];
      const current = predictions[index];
      const next = predictions[index + 1];

      if (current.time.getTime() <= nowTime) {
        continue;
      }

      const isHigh = current.value >= previous.value && current.value >= next.value;
      const isLow = current.value <= previous.value && current.value <= next.value;

      if (isHigh || isLow) {
        return {
          time: current.time,
          isHigh,
          value: current.value
        };
      }
    }

    return null;
  }

  function updateFromValues(current, low, high, next, sourceLabel) {
    const range = Math.max(high - low, 0.1);
    const normalized = Math.min(1, Math.max(0, (current.value - low) / range));
    const rising = current.rate >= 0;

    state.targetNormalizedHeight = normalized;
    state.targetDirection = rising ? 1 : -1;
    state.targetEnergy = Math.min(0.95, 0.18 + Math.abs(current.rate) * 0.9);

    setText(tideHeight, current.value.toFixed(1));
    setText(tideTrend, rising ? "Rising" : "Falling");

    if (next) {
      setText(eventLabel, next.isHigh ? "Next high tide" : "Next low tide");
      setText(eventTime, `${formatTime(next.time)} · ${next.value.toFixed(1)} ft`);
    } else {
      setText(eventLabel, "Tide field");
      setText(eventTime, "Moving with the coast");
    }

    setText(updatedAt, sourceLabel);
  }

  function showFallback() {
    const now = new Date();
    const tide = fallbackTide(now);

    updateFromValues(
      { value: tide.value, rate: tide.rate },
      tide.low,
      tide.high,
      {
        time: tide.nextTime,
        isHigh: tide.nextIsHigh,
        value: tide.nextIsHigh ? tide.high : tide.low
      },
      "Tide field · San Diego"
    );

    offlineNotice.hidden = false;
    offlineNotice.textContent = "Live NOAA data is temporarily unavailable. Showing a local tide cycle.";
  }

  async function loadTideData() {
    try {
      const response = await fetch(noaaURL(), {
        cache: "no-store",
        mode: "cors"
      });

      if (!response.ok) {
        throw new Error(`NOAA response: ${response.status}`);
      }

      const data = await response.json();

      if (!Array.isArray(data.predictions) || data.predictions.length < 3) {
        throw new Error("NOAA returned no prediction data");
      }

      const predictions = data.predictions.map((item) => ({
        time: parseNOAATime(item.t),
        value: Number(item.v)
      }));

      const now = new Date();
      const current = interpolate(predictions, now);
      const values = predictions.map((item) => item.value);
      const low = Math.min(...values);
      const high = Math.max(...values);
      const next = findNextTurningPoint(predictions, now);

      updateFromValues(current, low, high, next, `Live NOAA · Updated ${formatTime(now)}`);
      offlineNotice.hidden = true;
    } catch (error) {
      console.warn("NOAA tide data unavailable:", error);
      showFallback();
    }
  }

  function resizeCanvas() {
    const rect = canvas.getBoundingClientRect();

    state.pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    state.width = Math.max(1, Math.floor(rect.width));
    state.height = Math.max(1, Math.floor(rect.height));

    canvas.width = Math.floor(state.width * state.pixelRatio);
    canvas.height = Math.floor(state.height * state.pixelRatio);

    context.setTransform(state.pixelRatio, 0, 0, state.pixelRatio, 0, 0);
  }

  function drawBackground() {
    const gradient = context.createLinearGradient(0, 0, 0, state.height);

    gradient.addColorStop(0, "#071016");
    gradient.addColorStop(0.54, "#0a1b20");
    gradient.addColorStop(1, "#0b2227");

    context.fillStyle = gradient;
    context.fillRect(0, 0, state.width, state.height);
  }

  function drawLayer(layer, seconds, index) {
    const fullness = state.normalizedHeight;
    const energy = 0.35 + state.energy * 0.65;
    const baseLevel = state.height * (0.9 - fullness * 0.58);
    const depthOffset = (layer.depth - 0.5) * state.height * 0.31;
    const amplitude = layer.amplitude * (0.55 + energy * 0.7);
    const drift = seconds * layer.speed * state.direction;
    const yBase = baseLevel + depthOffset;
    const tint = 29 + Math.round(index * 2.1);
    const alpha = layer.opacity + fullness * 0.018;

    context.beginPath();
    context.moveTo(-30, state.height + 40);

    for (let x = -30; x <= state.width + 40; x += 14) {
      const firstWave = Math.sin(
        (x + drift + layer.phase * 80) / layer.wavelength
      );

      const secondWave = Math.sin(
        (x - drift * 0.42 + layer.phase * 130) / (layer.wavelength * 0.52)
      );

      const thirdWave = Math.cos(
        (x + drift * 0.19) / (layer.wavelength * 1.9)
      );

      const y =
        yBase +
        firstWave * amplitude +
        secondWave * amplitude * 0.25 +
        thirdWave * 7;

      context.lineTo(x, y);
    }

    context.lineTo(state.width + 40, state.height + 40);
    context.closePath();

    const fill = context.createLinearGradient(0, yBase - 100, 0, yBase + 140);

    fill.addColorStop(
      0,
      `rgba(${tint}, ${70 + index * 3}, ${73 + index * 3}, ${alpha})`
    );

    fill.addColorStop(1, `rgba(6, 29, 34, ${alpha * 0.2})`);

    context.fillStyle = fill;
    context.fill();

    context.beginPath();

    for (let x = -30; x <= state.width + 40; x += 14) {
      const firstWave = Math.sin(
        (x + drift + layer.phase * 80) / layer.wavelength
      );

      const secondWave = Math.sin(
        (x - drift * 0.42 + layer.phase * 130) / (layer.wavelength * 0.52)
      );

      const thirdWave = Math.cos(
        (x + drift * 0.19) / (layer.wavelength * 1.9)
      );

      const y =
        yBase +
        firstWave * amplitude +
        secondWave * amplitude * 0.25 +
        thirdWave * 7;

      if (x === -30) {
        context.moveTo(x, y);
      } else {
        context.lineTo(x, y);
      }
    }

    context.strokeStyle = `rgba(206, 225, 215, ${0.025 + fullness * 0.026})`;
    context.lineWidth = 0.7;
    context.stroke();
  }

  function draw(time) {
    const seconds = time * 0.001;
    const delta = Math.min((time - state.lastFrame) / 1000, 0.1);

    state.lastFrame = time;

    const smoothing = 1 - Math.pow(0.0008, delta);

    state.normalizedHeight +=
      (state.targetNormalizedHeight - state.normalizedHeight) * smoothing;

    state.energy += (state.targetEnergy - state.energy) * smoothing;

    if (Math.abs(state.targetDirection - state.direction) > 0.01) {
      state.direction +=
        (state.targetDirection - state.direction) * Math.min(1, delta * 0.13);
    }

    drawBackground();

    layers.forEach((layer, index) => {
      drawLayer(layer, seconds, index);
    });

    requestAnimationFrame(draw);
  }

  function createNoiseBuffer(audio) {
    const duration = 2;
    const length = audio.sampleRate * duration;
    const buffer = audio.createBuffer(1, length, audio.sampleRate);
    const channel = buffer.getChannelData(0);

    let previous = 0;

    for (let index = 0; index < length; index += 1) {
      const white = Math.random() * 2 - 1;
      previous = previous * 0.985 + white * 0.06;
      channel[index] = previous;
    }

    return buffer;
  }

  function startSound() {
    if (soundOn) {
      return;
    }

    const AudioContext = window.AudioContext || window.webkitAudioContext;

    if (!AudioContext) {
      return;
    }

    audioContext = audioContext || new AudioContext();

    const source = audioContext.createBufferSource();
    const filter = audioContext.createBiquadFilter();
    const gain = audioContext.createGain();

    source.buffer = createNoiseBuffer(audioContext);
    source.loop = true;

    filter.type = "lowpass";
    filter.frequency.value = 430;
    filter.Q.value = 0.45;

    gain.gain.value = 0.0001;

    source.connect(filter);
    filter.connect(gain);
    gain.connect(audioContext.destination);
    source.start();

    gain.gain.exponentialRampToValueAtTime(
      0.032,
      audioContext.currentTime + 1.4
    );

    noiseSource = source;
    noiseGain = gain;
    soundOn = true;

    soundToggle.setAttribute("aria-pressed", "true");
    soundToggle.setAttribute("aria-label", "Turn ambient sound off");
    setText(soundLabel, "Sound on");
  }

  function stopSound() {
    if (!soundOn || !noiseGain || !noiseSource || !audioContext) {
      return;
    }

    const source = noiseSource;
    const gain = noiseGain;

    gain.gain.cancelScheduledValues(audioContext.currentTime);
    gain.gain.setValueAtTime(
      Math.max(gain.gain.value, 0.0001),
      audioContext.currentTime
    );

    gain.gain.exponentialRampToValueAtTime(
      0.0001,
      audioContext.currentTime + 0.35
    );

    window.setTimeout(() => {
      try {
        source.stop();
      } catch (error) {
        // The audio source may already have stopped.
      }
    }, 400);

    noiseSource = null;
    noiseGain = null;
    soundOn = false;

    soundToggle.setAttribute("aria-pressed", "false");
    soundToggle.setAttribute("aria-label", "Turn ambient sound on");
    setText(soundLabel, "Sound off");
  }

  soundToggle.addEventListener("click", () => {
    if (soundOn) {
      stopSound();
    } else {
      startSound();
    }
  });

  window.addEventListener("resize", resizeCanvas, { passive: true });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden && soundOn) {
      stopSound();
    }
  });

  resizeCanvas();
  requestAnimationFrame(draw);
  showFallback();
  loadTideData();

  window.setInterval(() => {
    showFallback();
    loadTideData();
  }, REFRESH_MS);
})();
