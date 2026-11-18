export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function applyCalibration(sample, calibration) {
  if (sample.x == null || sample.y == null) return { x: null, z: null };
  if (!calibration || calibration.type === "identity") {
    return { x: sample.x, z: sample.y };
  }
  if (calibration.type === "affine") {
    return {
      x: calibration.ax * sample.x + calibration.bx * sample.y + calibration.cx,
      z: calibration.az * sample.x + calibration.bz * sample.y + calibration.cz,
    };
  }
  throw new Error(`Unsupported calibration type ${calibration.type}`);
}

export function fitRecordedSamples(rawSamples, lapDurationSeconds, fitConfig) {
  const meanX = rawSamples.reduce((sum, sample) => sum + sample.x, 0) / rawSamples.length;
  const meanY = rawSamples.reduce((sum, sample) => sum + sample.y, 0) / rawSamples.length;
  let xx = 0;
  let xy = 0;
  let yy = 0;
  for (const sample of rawSamples) {
    const dx = sample.x - meanX;
    const dy = sample.y - meanY;
    xx += dx * dx;
    xy += dx * dy;
    yy += dy * dy;
  }
  const rotationRadians = 0.5 * Math.atan2(2 * xy, xx - yy);
  const cosine = Math.cos(rotationRadians);
  const sine = Math.sin(rotationRadians);
  const rotated = rawSamples.map((sample) => {
    const dx = sample.x - meanX;
    const dy = sample.y - meanY;
    return {
      x: dx * cosine + dy * sine,
      y: -(dx * sine) + dy * cosine,
    };
  });
  const xs = rotated.map((point) => point.x);
  const ys = rotated.map((point) => point.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const scale = Math.min(fitConfig.xSpan / (maxX - minX || 1), fitConfig.zSpan / (maxY - minY || 1));
  const midX = (minX + maxX) / 2;
  const midY = (minY + maxY) / 2;
  const fitted = rawSamples.map((sample, index) => ({
    t: sample.t,
    x: (rotated[index].x - midX) * scale,
    z: (rotated[index].y - midY) * scale,
    speedKmh: sample.speedKmh,
    gear: sample.gear,
    throttle: sample.throttle,
    brake: sample.brake,
    drs: sample.drs,
  }));
  const closureX = fitted[fitted.length - 1].x - fitted[0].x;
  const closureZ = fitted[fitted.length - 1].z - fitted[0].z;
  const windowSeconds = fitConfig.closureSeconds;
  if (windowSeconds > 0) {
    for (const point of fitted) {
      const weight = Math.max(0, (point.t - (lapDurationSeconds - windowSeconds)) / windowSeconds);
      point.x -= closureX * weight;
      point.z -= closureZ * weight;
    }
  }
  const distances = [0];
  for (let index = 1; index < fitted.length; index += 1) {
    distances.push(distances[index - 1] + Math.hypot(fitted[index].x - fitted[index - 1].x, fitted[index].z - fitted[index - 1].z));
  }
  const length = distances[distances.length - 1];
  for (let index = 0; index < fitted.length; index += 1) {
    fitted[index].u = length === 0 ? 0 : distances[index] / length;
  }
  return {
    samples: fitted,
    length,
    scale,
    rotationRadians,
    closure: Math.hypot(closureX, closureZ),
  };
}

export function nearestProgress(samples, x, z) {
  let best = { distance: Infinity, u: 0, t: 0, index: 0 };
  for (let index = 0; index < samples.length - 1; index += 1) {
    const start = samples[index];
    const end = samples[index + 1];
    const dx = end.x - start.x;
    const dz = end.z - start.z;
    const denominator = dx * dx + dz * dz || 1;
    const fraction = clamp(((x - start.x) * dx + (z - start.z) * dz) / denominator, 0, 1);
    const distance = Math.hypot(x - (start.x + fraction * dx), z - (start.z + fraction * dz));
    if (distance < best.distance) {
      const spanU = end.u - start.u;
      const spanT = end.t - start.t;
      best = {
        distance,
        u: start.u + spanU * fraction,
        t: start.t + spanT * fraction,
        index,
      };
    }
  }
  return best;
}

export function sampleAtTime(samples, lapDurationSeconds, timeSeconds) {
  const duration = lapDurationSeconds || samples[samples.length - 1].t || 1;
  const time = ((timeSeconds % duration) + duration) % duration;
  let low = 0;
  let high = samples.length - 1;
  while (low + 1 < high) {
    const mid = (low + high) >> 1;
    if (samples[mid].t <= time) low = mid;
    else high = mid;
  }
  return interpolate(samples[low], samples[high], time, "t");
}

export function timeAtU(samples, lapDurationSeconds, progress) {
  if (progress <= 0) return 0;
  if (progress >= 1) return lapDurationSeconds;
  let low = 0;
  let high = samples.length - 1;
  while (low + 1 < high) {
    const mid = (low + high) >> 1;
    if (samples[mid].u <= progress) low = mid;
    else high = mid;
  }
  const start = samples[low];
  const end = samples[high];
  if (end.u === start.u) return start.t;
  const fraction = (progress - start.u) / (end.u - start.u);
  return start.t + (end.t - start.t) * fraction;
}

function interpolate(start, end, target, key) {
  const span = end[key] - start[key] || 1;
  const fraction = (target - start[key]) / span;
  return {
    t: start.t + (end.t - start.t) * fraction,
    u: start.u + (end.u - start.u) * fraction,
    x: start.x + (end.x - start.x) * fraction,
    z: start.z + (end.z - start.z) * fraction,
    speedKmh: start.speedKmh + (end.speedKmh - start.speedKmh) * fraction,
  };
}
