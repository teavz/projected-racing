const spectator = new URLSearchParams(location.search).get("mode") === "spectator";
if (spectator) document.body.classList.add("spectator");
const $ = (id) => document.getElementById(id);
let sessionId = null;

function fmt(ms) {
  if (!Number.isFinite(ms)) return "—";
  const sign = ms < 0 ? "-" : "";
  const abs = Math.abs(Math.round(ms));
  return `${sign}${Math.floor(abs / 60000)}:${String(Math.floor((abs % 60000) / 1000)).padStart(2, "0")}.${String(abs % 1000).padStart(3, "0")}`;
}

function apply(snap) {
  if (!snap) return;
  sessionId = snap.sessionId;
  $("circuitLabel").textContent = `${snap.circuitName} · ${snap.difficulty} · ${snap.startMode}`;
  $("banner").textContent = snap.banner;
  $("instructions").textContent = snap.instructions;
  $("lap").textContent = snap.display.lap;
  $("delta").textContent = snap.display.delta;
  $("boss").textContent = snap.display.boss;
  $("best").textContent = snap.display.best;
  $("tracking").textContent = snap.tracking;
  $("feed").textContent = snap.feedStatus;
  $("attempt").textContent = String(snap.attemptNumber || "—");
  const banner = $("banner").parentElement;
  banner.className = "banner";
  if (["INVALID LAP", "OFFLINE", "DNF"].includes(snap.banner)) banner.classList.add("invalid");
  else if (["LOST TRACKING", "HOLD"].includes(snap.banner)) banner.classList.add("lost");
  else if (snap.banner === "BEAT THE GRID") banner.classList.add("good");
  const rows = snap.leaderboardPreview.map((row) => `<tr><td>${row.rank}</td><td>${row.driverName}</td><td>${fmt(row.lapTimeMs)}</td><td>${fmt(row.deltaMs)}</td></tr>`).join("");
  $("board").innerHTML = rows || "<tr><td colspan='4'>No valid laps yet</td></tr>";
  const quality = snap.quality;
  $("quality").textContent = `samples ${quality.received} · rejected ${quality.rejected} · gaps ${quality.sequenceGaps} · false crossings ${quality.falseCrossings} · drift ${Math.round(quality.driftMs)} ms · last rejection ${quality.lastRejection?.code ?? "none"}`;
}

async function api(path, options) {
  const response = await fetch(path, { headers: { "content-type": "application/json" }, ...options });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message ?? response.statusText);
  return body;
}

async function boot() {
  const { circuits } = await api("/v1/circuits");
  $("circuit").innerHTML = circuits.map((circuit) => `<option value="${circuit.id}">${circuit.name}</option>`).join("");
  if (!circuits.length) $("instructions").textContent = "No ghost is loaded. Recompute ghosts from the recorded laps first.";
}

async function ensureSession() {
  if (sessionId) return sessionId;
  const created = await api("/v1/sessions", { method: "POST", body: JSON.stringify({ circuitId: $("circuit").value, difficulty: $("difficulty").value }) });
  apply(created);
  listen(created.sessionId);
  return created.sessionId;
}

function listen(id) {
  const source = new EventSource(`/v1/sessions/${id}/stream`);
  source.addEventListener("snapshot", (event) => apply(JSON.parse(event.data)));
}

async function command(type, extra = {}) {
  const id = await ensureSession();
  apply(await api(`/v1/sessions/${id}/commands`, { method: "POST", body: JSON.stringify({ type, ...extra }) }));
}

$("register").onclick = () => command("register-driver", { name: $("driver").value });
$("start").onclick = () => command("start");
$("reset").onclick = () => command("reset");
$("hold").onclick = () => command("hold");
$("release").onclick = () => command("release");
$("simulate").onclick = async () => {
  const id = await ensureSession();
  if ($("driver").value) await command("register-driver", { name: $("driver").value });
  apply(await api(`/v1/sessions/${id}/simulate`, { method: "POST", body: JSON.stringify({ driverName: $("driver").value || "Sim Driver", countdownMs: 0 }) }));
};
$("circuit").onchange = () => { sessionId = null; };
boot().catch((error) => { $("instructions").textContent = error.message; });
