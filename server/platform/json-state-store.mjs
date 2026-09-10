import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const clone = (value) => JSON.parse(JSON.stringify(value));

export function createJsonStateStore({ envName, defaultFile, initialState }) {
  const configured = String(process.env[envName] || "").trim();
  const memoryOnly = configured === ":memory:";
  const file = memoryOnly
    ? null
    : isAbsolute(configured)
      ? configured
      : join(projectRoot, configured || defaultFile);
  let state = clone(initialState);

  const loadFromDisk = () => {
    if (!file) return clone(state);
    try {
      state = { ...clone(initialState), ...JSON.parse(readFileSync(file, "utf8")) };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    return clone(state);
  };
  const load = () => clone(state);

  const save = (nextState) => {
    const next = clone(nextState);
    if (!file) { state = next; return; }
    mkdirSync(dirname(file), { recursive:true });
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding:"utf8", mode:0o600 });
    renameSync(temporary, file);
    state = next;
  };

  const reset = () => save(initialState);
  loadFromDisk();
  return {
    load,
    reload:loadFromDisk,
    save,
    reset,
    status:() => ({ driver:file ? "local_json" : "memory", durable:Boolean(file), file:file || null })
  };
}
