import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { asAppError } from "./errors.js";
import { servoSchemaDescription } from "./schema.js";

const dashboardDir = path.resolve(fileURLToPath(new URL("../dashboard/", import.meta.url)));
const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8" };

function send(response, status, body, type = "application/json; charset=utf-8") {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  response.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  response.end(payload);
}

async function readJson(request, limit = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error("Body too large"), { status: 413, code: "body_too_large" });
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("Body must be JSON"), { status: 400, code: "invalid_json" });
  }
}

export function createServer(app, config) {
  const server = http.createServer(async (request, response) => {
    const started = Date.now();
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      const parts = url.pathname.split("/").filter(Boolean);
      if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/dashboard" || url.pathname === "/dashboard/")) {
        return send(response, 200, fs.readFileSync(path.join(dashboardDir, "index.html")), types[".html"]);
      }
      if (request.method === "GET" && url.pathname.startsWith("/dashboard/")) {
        const name = path.basename(url.pathname);
        const file = path.join(dashboardDir, name);
        if (!file.startsWith(dashboardDir) || !fs.existsSync(file)) return send(response, 404, { error: { code: "not_found", message: "Not found" } });
        return send(response, 200, fs.readFileSync(file), types[path.extname(file)] ?? "application/octet-stream");
      }
      if (request.method === "GET" && url.pathname === "/health") return send(response, 200, { ok: true, service: "projected-racing", schemaVersion: 1 });
      if (request.method === "GET" && url.pathname === "/v1/schema/servo") return send(response, 200, servoSchemaDescription());
      if (request.method === "GET" && url.pathname === "/v1/circuits") return send(response, 200, { circuits: app.listCircuits() });
      if (request.method === "GET" && url.pathname === "/v1/leaderboard") {
        return send(response, 200, { leaderboard: await app.leaderboard({ circuitId: url.searchParams.get("circuitId") ?? undefined, difficulty: url.searchParams.get("difficulty") ?? undefined }) });
      }
      if (request.method === "GET" && url.pathname === "/v1/metrics") {
        return send(response, 200, { ...app.metrics(), lastSnapshotLatencyMs: Date.now() - started });
      }
      if (request.method === "POST" && url.pathname === "/v1/ghosts/recompute") return send(response, 200, { ghosts: await app.recomputeGhosts() });
      if (request.method === "POST" && url.pathname === "/v1/sessions") return send(response, 201, await app.createSession(await readJson(request)));
      if (parts[0] === "v1" && parts[1] === "sessions" && parts[2] && request.method === "GET" && parts.length === 3) {
        return send(response, 200, await app.snapshot(parts[2]));
      }
      if (parts[0] === "v1" && parts[1] === "sessions" && parts[2] && parts[3] === "commands" && request.method === "POST") {
        return send(response, 200, await app.command(parts[2], await readJson(request)));
      }
      if (parts[0] === "v1" && parts[1] === "sessions" && parts[2] && parts[3] === "samples" && request.method === "POST") {
        const body = await readJson(request);
        const result = await app.ingest(parts[2], body.samples ?? body);
        return send(response, 200, { ...result, latencyMs: Date.now() - started });
      }
      if (parts[0] === "v1" && parts[1] === "sessions" && parts[2] && parts[3] === "simulate" && request.method === "POST") {
        return send(response, 200, await app.simulate(parts[2], await readJson(request)));
      }
      if (parts[0] === "v1" && parts[1] === "sessions" && parts[2] && parts[3] === "stream" && request.method === "GET") {
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        const snap = await app.snapshot(parts[2]);
        response.write(`event: snapshot\ndata: ${JSON.stringify(snap)}\n\n`);
        const unsubscribe = app.subscribe((sessionId, next) => {
          if (sessionId === parts[2]) response.write(`event: snapshot\ndata: ${JSON.stringify(next)}\n\n`);
        });
        request.on("close", unsubscribe);
        return;
      }
      return send(response, 404, { error: { code: "not_found", message: "Not found" } });
    } catch (error) {
      const wrapped = error.status ? error : asAppError(error);
      send(response, wrapped.status ?? 500, { error: { code: wrapped.code ?? "internal", message: wrapped.message, details: wrapped.details } });
    }
  });
  const timer = setInterval(() => { app.tick().catch((error) => console.error(error)); }, 200);
  timer.unref();
  return {
    server,
    listen() {
      return new Promise((resolve) => {
        server.listen(config.server.port, config.server.host, () => resolve(server.address()));
      });
    },
    close() {
      clearInterval(timer);
      return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}
