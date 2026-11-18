export function flyingLapSamples({ lapMs = 4000, startMs = 0, servoId = "servo-human-1", sequenceStart = 1, unlockAtU = null, gapAtU = null, maxGapMs = 1000 }) {
  const duration = Math.max(1, Math.round(lapMs));
  const gapLimit = Math.max(1, Math.floor(maxGapMs));
  if (0.08 * duration <= gapLimit && 0.06 * duration <= gapLimit) {
    return legacyFlyingLapSamples({ lapMs: duration, startMs, servoId, sequenceStart, unlockAtU, gapAtU });
  }
  return denseFlyingLapSamples({ lapMs: duration, startMs, servoId, sequenceStart, unlockAtU, gapAtU, maxGapMs: gapLimit });
}

function legacyFlyingLapSamples({ lapMs, startMs, servoId, sequenceStart, unlockAtU, gapAtU }) {
  const fromU = 0.96;
  const toU = 0.02;
  const gapU = (1 - fromU) + toU;
  const gapMs = gapU * lapMs;
  const crossOffset = (1 - fromU) * lapMs;
  const samples = [];
  let sequence = sequenceStart;
  const add = (progress, offsetMs) => {
    if (gapAtU != null && progress >= gapAtU && samples.at(-1)?.sequence === sequence - 1) sequence += 2;
    const sample = {
      schemaVersion: 1,
      servoId,
      role: "human",
      sequence,
      sourceTimeMs: Math.round(startMs + offsetMs),
      clock: "epoch",
      progress: Number(progress.toFixed(6)),
      lock: !(unlockAtU != null && progress >= unlockAtU),
      quality: unlockAtU != null && progress >= unlockAtU ? 0 : 1,
    };
    samples.push(sample);
    sequence += 1;
  };
  add(fromU, 0);
  add(toU, gapMs);
  for (let progress = 0.12; progress < fromU; progress += 0.08) add(progress, crossOffset + progress * lapMs);
  add(fromU, crossOffset + fromU * lapMs);
  add(toU, crossOffset + fromU * lapMs + gapMs);
  return samples;
}

function denseFlyingLapSamples({ lapMs, startMs, servoId, sequenceStart, unlockAtU, gapAtU, maxGapMs }) {
  const wingMs = Math.min(Math.max(1, Math.round(0.04 * lapMs)), Math.floor((maxGapMs - 1) / 2));
  const wing = wingMs / lapMs;
  const stepMs = Math.max(1, Math.min(maxGapMs - 1, Math.floor(lapMs * 0.19)));
  const points = [
    { progress: 1 - wing, offsetMs: 0 },
    { progress: wing, offsetMs: 2 * wingMs },
  ];
  for (let offsetMs = 2 * wingMs + stepMs; offsetMs < lapMs; offsetMs += stepMs) {
    const progress = (offsetMs - wingMs) / lapMs;
    if (progress <= wing || progress >= 1 - wing) continue;
    points.push({ progress, offsetMs });
  }
  points.push({ progress: 1 - wing, offsetMs: lapMs });
  points.push({ progress: wing, offsetMs: lapMs + 2 * wingMs });
  const samples = [];
  let sequence = sequenceStart;
  for (const point of points) {
    const progress = Number(point.progress.toFixed(6));
    if (gapAtU != null && progress >= gapAtU && samples.at(-1)?.sequence === sequence - 1) sequence += 2;
    samples.push({
      schemaVersion: 1,
      servoId,
      role: "human",
      sequence,
      sourceTimeMs: Math.round(startMs + point.offsetMs),
      clock: "epoch",
      progress,
      lock: !(unlockAtU != null && progress >= unlockAtU),
      quality: unlockAtU != null && progress >= unlockAtU ? 0 : 1,
    });
    sequence += 1;
  }
  return samples;
}

export function circlePositionSamples({ radius = 10, startMs = 0, servoId = "servo-human-1", sequenceStart = 1, lateral = 0, count = 40 }) {
  const samples = [];
  let sequence = sequenceStart;
  for (let index = 0; index < count; index += 1) {
    const fraction = index / count;
    const angle = fraction * Math.PI * 2;
    const offset = index === Math.floor(count * 0.7) ? lateral : 0;
    samples.push({
      schemaVersion: 1,
      servoId,
      role: "human",
      sequence,
      sourceTimeMs: startMs + index * 100,
      clock: "epoch",
      x: radius * Math.cos(angle) + offset,
      y: radius * Math.sin(angle),
      lock: true,
      quality: 1,
    });
    sequence += 1;
  }
  return samples;
}
