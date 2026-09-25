(() => {
  "use strict";

  const STATION_ID = "9410170";
  const REFRESH_MS = 30 * 60 * 1000;
  const API_BASE = "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter";

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
    targetHeight: 2.4,
    displayedHeight: 2.4,
    normalizedHeight: 0.5,
    targetNormalizedHeight: 0.5,
    direction: 1,
    targetDirection: 1,
    energy: 0.22,
    targetEnergy: 0.22,
    lastFrame: performance.now(),
    dataLoaded: false
  };

  const layers = Array.from({ length: 12 }, (_, index) => ({
    depth: index / 11,
    speed: 0.13 + index * 0.029,
    amplitude: 18 + index * 5.2,
    wavelength: 160 + index * 33,
    phase: Math.random() * Math.PI * 2,
    opacity: 0.024 + index * 0.008
  }));

  let audioContext = null;
  let noiseSource = null;
  let noiseGain = null;
  let soundOn = false;

  function pad(number) {
    return String(number).padStart(2, "0");
  }

  function dateString(date) {
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
  }

  function noaaURL(interval) {
    const now = new Date();

    const parameters = new URLSearchParams({
      begin_date: dateString(now),
      range: "48",
      station: STATION_ID,
      product: "predictions",
      datum: "MLLW",
      time_zone: "lst_ldt",
      units: "english",
      interval,
      format: "json",
      application: "tide_field"
    });

    return `${API_BASE}?${parameters.toString()}`;
  }

  function parseNOAATime(value) {
    const [datePart, timePart] = value.split(" ");
    const [year, month, day] = datePart.split("-").map(Number);
    const [hour, minute] = timePart.split(":").map(Number);

    return new Date(year, month - 1, day, hour, minute, 0);
  }

  function interpolatePrediction(predictions, now) {
    const nowTime = now.getTime();

    for (let index = 0; index < predictions.length - 1; index += 1) {
      const before = predictions[index];
      const after = predictions[index + 1];

      if (before.time.getTime() <= nowTime && after.time.getTime() >= nowTime) {
        const span = after.time.getTime() - before.time.getTime();
        const progress = span === 0
          ? 0
          : (nowTime - before.time.getTime()) / span;

        return {
          value: before.value + (after.value - before.value) * progress,
          rate: (after.value - before.value) / span
        };
      }
    }

    const closest = predictions.reduce((best, item) => {
      const bestDistance = Math.abs(best.time.getTime() - nowTime);
      const itemDistance = Math.abs(item.time.getTime() - nowTime);
      return itemDistance < bestDistance ? item : best;
    });

    return {
      value: closest.value,
      rate: 0
    };
  }

  function formatClock(date) {
    return new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      minute: "2-digit"
    }).format(date);
  }

  function setText(element, value) {
    element.textContent = value;
  }

  function updateReadout(predictions, events) {
    const now = new Date();
    const current = interpolatePrediction(predictions, now);
    const values = predictions.map((prediction) => prediction.value);
    const low = Math.min(...values);
    const high = Math.max(...values);
    const range = Math.max(high - low, 0.1);
    const normalized = Math.min(1, Math.max(0, (current.value - low) / range));
    const rising = current.rate >= 0;

    const nextEvent = events.find((event) => event.time.getTime() > now.getTime());

    state.targetHeight = current.value;
    state.targetNormalizedHeight = normalized;
    state.targetDirection = rising ? 1 : -1;
    state.targetEnergy = Math.min(1, Math.abs(current.rate) * 1000 * 180);

    setText(tideHeight, current.value.toFixed(1));
    setText(tideTrend, rising ? "Rising" : "Falling");

    if (nextEvent) {
      setText(
        eventLabel,
        nextEvent.type === "H" ? "Next high tide" : "Next low tide"
      );

      setText(
        eventTime,
        `${formatClock(nextEvent.time)} · ${nextEvent.value.toFixed(1)} ft`
      );
    } else {
      setText(eventLabel, "San Diego tide");
      setText(eventTime, "Updating shortly");
    }

    setText(updatedAt, `Updated ${formatClock(now)}`);
    offlineNotice.hidden = true;
    state.dataLoaded = true;
  }

  async function loadTideData() {
    try {
      const [predictionsResponse, eventsResponse] = await Promise.all([
        fetch(noaaURL("15"), { cache: "no-store" }),
        fetch(noaaURL("hilo"), { cache: "no-store" })
      ]);

      if (!predictionsResponse.ok || !eventsResponse.ok) {
        throw new Error("NOAA request failed");
      }

      const predictionsData = await predictionsResponse.json();
      const eventsData = await eventsResponse.json();

      if (
        !Array.isArray(predictionsData.predictions) ||
        !Array.isArray(eventsData.predictions)
      ) {
        throw new Error("NOAA returned no prediction data");
      }

      const predictions = predictionsData.predictions.map((item) => ({
        time: parseNOAATime(item.t),
        value: Number(item.v)
      }));

      const events = eventsData.predictions.map((item) => ({
        time: parseNOAATime(item.t),
        value: Number(item.v),
        type: item.type
      }));

      if (predictions.length < 2) {
        throw new Error("Not enough tide predictions");
      }

      updateReadout(predictions, events);
    } catch (error) {
      console.error("Tide data error:", error);

      offlineNotice.hidden = false;

      if (!state.dataLoaded) {
        setText(tideHeight, "—");
        setText(tideTrend, "Tide data unavailable");
        setText(eventLabel, "San Diego");
        setText(eventTime, "Trying again soon");
        setText(updatedAt, "Live data unavailable");
      }
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

  function drawLayer(layer, time, index) {
    const width = state.width;
    const height = state.height;
    const fullness = state.normalizedHeight;
    const energy = 0.3 + state.energy * 0.7;
    const baseLevel = height * (0.9 - fullness * 0.58);
    const depthOffset = (layer.depth - 0.5) * height * 0.31;
    const waveAmplitude = layer.amplitude * (0.55 + energy * 0.7);
    const drift = time * layer.speed * state.direction;
    const yBase = baseLevel + depthOffset;
    const tint = 29 + Math.round(index * 2.1);
    const alpha = layer.opacity + fullness * 0.018;

    context.beginPath();
    context.moveTo(-30, height + 40);

    for (let x = -30; x <= width + 40; x += 14) {
      const waveOne = Math.sin(
        (x + drift + layer.phase * 80) / layer.wavelength
      );
      const waveTwo = Math.sin(
        (x - drift * 0.42 + layer.phase * 130) / (layer.wavelength * 0.52)
      );
      const waveThree = Math.cos(
        (x + drift * 0.19) / (layer.wavelength * 1.9)
      );

      const y =
        yBase +
        waveOne * waveAmplitude +
        waveTwo * waveAmplitude * 0.25 +
        waveThree * 7;

      context.lineTo(x, y);
    }

    context.lineTo(width + 40, height + 40);
    context.closePath();

    const fill = context.createLinearGradient(
      0,
      yBase - 100,
      0,
      yBase + 140
    );

    fill.addColorStop(
      0,
      `rgba(${tint}, ${70 + index * 3}, ${73 + index * 3}, ${alpha})`
    );

    fill.addColorStop(1, `rgba(6, 29, 34, ${alpha * 0.2})`);

    context.fillStyle = fill;
    context.fill();

    context.beginPath();

    for (let x = -30; x <= width + 40; x += 14) {
      const waveOne = Math.sin(
        (x + drift + layer.phase * 80) / layer.wavelength
      );
      const waveTwo = Math.sin(
        (x - drift * 0.42 + layer.phase * 130) / (layer.wavelength * 0.52)
      );
      const waveThree = Math.cos(
        (x + drift * 0.19) / (layer.wavelength * 1.9)
      );

      const y =
        yBase +
        waveOne * waveAmplitude +
        waveTwo * waveAmplitude * 0.25 +
        waveThree * 7;

      if (x === -30) {
        context.moveTo(x, y);
      } else {
        context.lineTo(x, y);
      }
    }

    context.strokeStyle = `rgba(206, 225, 215, ${
      0.025 + fullness * 0.026
    })`;

    context.lineWidth = 0.7;
    context.stroke();
  }

  function draw(time) {
    const seconds = time * 0.001;
    const delta = Math.min((time - state.lastFrame) / 1000, 0.1);

    state.lastFrame = time;

    const smoothing = 1 - Math.pow(0.0008, delta);

    state.displayedHeight +=
      (state.targetHeight - state.displayedHeight) * smoothing;

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
    const frameCount = audio.sampleRate * duration;
    const buffer = audio.createBuffer(1, frameCount, audio.sampleRate);
    const channel = buffer.getChannelData(0);

    let last = 0;

    for (let index = 0; index < frameCount; index += 1) {
      const white = Math.random() * 2 - 1;
      last = last * 0.985 + white * 0.06;
      channel[index] = last;
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
        // Source has already stopped.
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
  loadTideData();
  window.setInterval(loadTideData, REFRESH_MS);
})();
