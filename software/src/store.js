import fs from "node:fs";
import path from "node:path";
import { AppError } from "./errors.js";

function safeId(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]+$/.test(value)) {
    throw new AppError("invalid_storage_key", `${label} contains unsupported characters`, 500);
  }
  return value;
}

export function createMemoryStore() {
  const objects = new Map();
  const events = new Map();
  const records = new Map();
  return {
    kind: "memory",
    async putObject(key, value) {
      objects.set(key, structuredClone(value));
    },
    async getObject(key) {
      return objects.has(key) ? structuredClone(objects.get(key)) : null;
    },
    async appendEvent(sessionId, event) {
      const id = safeId(sessionId, "sessionId");
      const list = events.get(id) ?? [];
      list.push(structuredClone(event));
      events.set(id, list);
    },
    async readEvents(sessionId) {
      return structuredClone(events.get(safeId(sessionId, "sessionId")) ?? []);
    },
    async saveRecord(collection, id, value) {
      const key = `${safeId(collection, "collection")}/${safeId(id, "id")}`;
      records.set(key, structuredClone(value));
    },
    async getRecord(collection, id) {
      const key = `${safeId(collection, "collection")}/${safeId(id, "id")}`;
      return records.has(key) ? structuredClone(records.get(key)) : null;
    },
    async listRecords(collection) {
      const prefix = `${safeId(collection, "collection")}/`;
      return [...records.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([, value]) => structuredClone(value));
    },
    async close() {},
  };
}

export function createFileStore(directory) {
  const root = path.resolve(directory);
  let chain = Promise.resolve();
  const enqueue = (fn) => {
    const run = chain.then(fn, fn);
    chain = run.then(() => {}, () => {});
    return run;
  };
  const ensure = (dir) => fs.mkdirSync(dir, { recursive: true });
  const writeAtomic = (file, contents) => {
    ensure(path.dirname(file));
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, contents);
    fs.renameSync(temporary, file);
  };
  const objectPath = (key) => {
    if (typeof key !== "string" || key.includes("..") || path.isAbsolute(key)) {
      throw new AppError("invalid_storage_key", "Object key is not allowed", 500);
    }
    return path.join(root, "objects", key);
  };
  return {
    kind: "file",
    directory: root,
    async putObject(key, value) {
      return enqueue(() => writeAtomic(objectPath(key), JSON.stringify(value)));
    },
    async getObject(key) {
      return enqueue(() => {
        const file = objectPath(key);
        return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
      });
    },
    async appendEvent(sessionId, event) {
      return enqueue(() => {
        const file = path.join(root, "events", `${safeId(sessionId, "sessionId")}.jsonl`);
        ensure(path.dirname(file));
        fs.appendFileSync(file, `${JSON.stringify(event)}\n`);
      });
    },
    async readEvents(sessionId) {
      return enqueue(() => {
        const file = path.join(root, "events", `${safeId(sessionId, "sessionId")}.jsonl`);
        if (!fs.existsSync(file)) return [];
        return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
      });
    },
    async saveRecord(collection, id, value) {
      return enqueue(() => writeAtomic(path.join(root, "records", safeId(collection, "collection"), `${safeId(id, "id")}.json`), JSON.stringify(value)));
    },
    async getRecord(collection, id) {
      return enqueue(() => {
        const file = path.join(root, "records", safeId(collection, "collection"), `${safeId(id, "id")}.json`);
        return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
      });
    },
    async listRecords(collection) {
      return enqueue(() => {
        const dir = path.join(root, "records", safeId(collection, "collection"));
        if (!fs.existsSync(dir)) return [];
        return fs.readdirSync(dir).filter((entry) => entry.endsWith(".json")).map((entry) => JSON.parse(fs.readFileSync(path.join(dir, entry), "utf8")));
      });
    },
    async close() {},
  };
}
