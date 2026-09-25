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
    const tomorrow = new Date(now);
    tomorrow.setDate(now.getDate() + 1);

    const parameters = new URLSearchParams({
      begin_date: dateString(now),
      end_date: dateString(tomorrow),
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

  function closestPrediction(predictions, now) {
    return predictions.reduce((closest, prediction) => {
      const distance = Math.abs(prediction.time.getTime() - now.getTime());
      const closestDistance = Math.abs(closest.time.getTime() - now.getTime());
      return distance < closestDistance ? prediction : closest;
    });
  }

  function interpolatePrediction(predictions, now) {
    const nowTime = now.getTime();

    for (let index = 0; index < predictions.length - 1; index += 1) {
      const before = predictions[index];
      const after = predictions[index + 1];

      if (before.time.getTime() <= nowTime && after.time.getTime() >= nowTime) {
        const span = after.time.getTime() - before.time.getTime();
        const progress = span === 0 ? 0 : (nowTime - before.time.getTime()) / span;

        return {
          value: before.value + (after.value - before.value) * progress,
          rate: (after.value - before.value) / span
        };
      }
    }

    const closest = closestPrediction(predictions, now);

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

  function formatUpdated(date) {
    return `Updated ${formatClock(date)}`;
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
    const riseOrFall = current.rate >= 0 ? "rising" : "falling";

    const futureEvents = events.filter((event) => event.time.getTime() > now.getTime());
    const nextEvent = futureEvents[0];

    state.targetHeight = current.value;
    state.targetNormalizedHeight = normalized;
    state.targetDirection = current.rate >= 0 ? 1 : -1;
    state.targetEnergy = Math.min(1, Math.abs(current.rate) * 1000 * 180);

    setText(tideHeight, current.value.toFixed(1));
    setText(tideTrend, riseOrFall);

    if (nextEvent) {
      const isHigh = nextEvent.type === "H";
      setText(eventLabel, isHigh ? "Next high tide" : "Next low tide");
      setText(eventTime, `${formatClock(nextEvent.time)} · ${nextEvent.value.toFixed(1)} ft`);
    } else {
      setText(eventLabel, "Tide prediction");
      setText(eventTime, "Later today");
    }

    setText(updatedAt, formatUpdated(now));
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
        throw new Error("Tide request failed");
      }

      const predictionsData = await predictionsResponse.json();
      const eventsData = await eventsResponse.json();

      if (!predictionsData.predictions || !eventsData.predictions) {
        throw new Error("Tide data was unavailable");
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
    const energy = 0.3
