import assert from "node:assert/strict";
import { createConcurrencyGate } from "../server/platform/concurrency-gate.mjs";

const gate = createConcurrencyGate({
  name:"test_gate",
  maxConcurrent:2,
  maxQueue:2,
  queueTimeoutMs:80
});

const first = await gate.acquire({ lane:"knowledge" });
const second = await gate.acquire({ lane:"knowledge" });
assert.equal(gate.stats().active, 2);

const waitingKnowledge = gate.acquire({ lane:"knowledge" });
const waitingMedical = gate.acquire({ lane:"medical" });
assert.equal(gate.stats().queued, 2);
await assert.rejects(
  () => gate.acquire({ lane:"knowledge" }),
  (error) => error.code === "QUEUE_FULL"
);

first();
const medicalRelease = await waitingMedical;
assert.equal(gate.stats().active, 2, "释放一个槽位应立即接纳高优先级医疗请求");
assert.equal(gate.stats().queued, 1);
second();
const knowledgeRelease = await waitingKnowledge;
assert.equal(gate.stats().active, 2);
medicalRelease();
knowledgeRelease();

const timeoutGate = createConcurrencyGate({
  name:"timeout_gate",
  maxConcurrent:1,
  maxQueue:1,
  queueTimeoutMs:20
});
const held = await timeoutGate.acquire();
await assert.rejects(
  () => timeoutGate.acquire({ lane:"knowledge" }),
  (error) => error.code === "QUEUE_TIMEOUT"
);
held();

const circuitGate = createConcurrencyGate({
  name:"circuit_gate",
  maxConcurrent:1,
  maxQueue:1,
  failureThreshold:2,
  openMs:100
});
const circuitRelease = await circuitGate.acquire();
circuitGate.recordFailure();
circuitGate.recordFailure();
circuitRelease();
await assert.rejects(
  () => circuitGate.acquire(),
  (error) => error.code === "CIRCUIT_OPEN"
);
assert.equal(circuitGate.stats().circuit, "open");

console.log("✓ 并发闸门：全局上限、有界队列、优先级、超时与熔断通过");
