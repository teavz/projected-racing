import crypto from "node:crypto";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export function acceptKey(key) {
  return crypto.createHash("sha1").update(`${key}${GUID}`).digest("base64");
}

export function encodeTextFrame(text) {
  const payload = Buffer.from(text);
  if (payload.length > 65535) throw new Error("frame_too_large");
  const header = payload.length < 126
    ? Buffer.from([0x81, payload.length])
    : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 0xff]);
  return Buffer.concat([header, payload]);
}

export function decodeClientFrames(buffer) {
  const messages = [];
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const opcode = buffer[offset] & 0x0f;
    const second = buffer[offset + 1];
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let cursor = offset + 2;
    if (length === 126) {
      if (buffer.length < cursor + 2) break;
      length = buffer.readUInt16BE(cursor);
      cursor += 2;
    } else if (length === 127) {
      throw Object.assign(new Error("Frame is too large"), { code: "frame_too_large" });
    }
    if (buffer.length < cursor + (masked ? 4 : 0) + length) break;
    let payload = buffer.subarray(cursor + (masked ? 4 : 0), cursor + (masked ? 4 : 0) + length);
    if (masked) {
      const mask = buffer.subarray(cursor, cursor + 4);
      payload = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]));
    }
    offset = cursor + (masked ? 4 : 0) + length;
    if (opcode === 0x8) messages.push(null);
    else if (opcode === 0x1) messages.push(payload.toString("utf8"));
  }
  return { messages, rest: buffer.subarray(offset) };
}

export function attachMotionSocket(server, app) {
  server.on("upgrade", (request, socket) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const key = request.headers["sec-websocket-key"];
    if (url.pathname !== "/ws/hw" || !key || !url.searchParams.get("session")) {
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      return;
    }
    const sessionId = url.searchParams.get("session");
    socket.write([
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${acceptKey(key)}`,
      "",
      "",
    ].join("\r\n"));
    let pending = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      let decoded;
      try {
        decoded = decodeClientFrames(pending);
      } catch (error) {
        socket.end(encodeTextFrame(JSON.stringify({ error: { code: error.code ?? "bad_frame", message: error.message } })));
        return;
      }
      pending = Buffer.from(decoded.rest);
      for (const message of decoded.messages) {
        if (message == null) {
          socket.end();
          return;
        }
        let body;
        try {
          body = JSON.parse(message);
        } catch {
          socket.write(encodeTextFrame(JSON.stringify({ error: { code: "invalid_json", message: "Motion socket messages must be JSON" } })));
          continue;
        }
        app.ingestMotion(sessionId, body).then((result) => {
          socket.write(encodeTextFrame(JSON.stringify({
            accepted: result.results.filter((item) => item?.accepted).length,
            rejected: result.results.filter((item) => item && item.accepted === false).length,
            health: result.health,
          })));
        }).catch((error) => {
          socket.write(encodeTextFrame(JSON.stringify({ error: { code: error.code ?? "motion_socket", message: error.message } })));
        });
      }
    });
  });
}
