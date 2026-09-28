#!/usr/bin/env node
// Conformance harness for node-avo-inspector (avohq/spec-first-inspector-server-sdk).
// Implements conformance/runner-contract.md: reads one JSON envelope from stdin, drives
// the built SDK (dist/), writes one JSON envelope to stdout. No assertion logic here.
//
// Build first (`yarn build`); scripts/run-conformance.sh does both.

"use strict";

const HARNESS_CONTRACT_VERSION = "1.1.0";

// stdout carries only the output envelope; route SDK logging to stderr.
console.log = (...args) => console.error(...args);
console.info = (...args) => console.error(...args);
console.warn = (...args) => console.error(...args);

const { AvoInspector } = require("../dist/index.js");

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on("data", (c) => chunks.push(c));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}

// Thrown by exitWith so that nothing after it runs while the envelope is being written.
const EXITING = Symbol("exiting");

// Always leave through process.exit(): it skips the SDK's "beforeExit" drain, which would
// otherwise send events a fixture expects to stay buffered (wire-8 expects 0 requests).
// Writes to a pipe can complete asynchronously, so exit only once the envelope is flushed.
function exitWith(code, envelope) {
  process.stdout.write(JSON.stringify(envelope) + "\n", () => process.exit(code));
  throw EXITING;
}

function configError(fixtureId, message) {
  exitWith(2, { fixture_id: fixtureId ?? null, passed: false, actual: null, outcome: "resolve", error: message });
}

function applyPrecondition(inspector, precondition, fixtureId) {
  if (!precondition || typeof precondition !== "object") return;
  for (const key of Object.keys(precondition)) {
    if (key === "samplingRate") {
      inspector._setSamplingRateForTesting(precondition.samplingRate);
    } else {
      configError(fixtureId, `unsupported precondition field: ${key}`);
    }
  }
}

// Omit trailing arguments the fixture does not supply; options are passed verbatim.
function callTrack(inspector, eventName, eventProperties, streamId, options) {
  if (options !== undefined) {
    return inspector.trackSchemaFromEvent(eventName, eventProperties, streamId, options);
  }
  return streamId === undefined
    ? inspector.trackSchemaFromEvent(eventName, eventProperties)
    : inspector.trackSchemaFromEvent(eventName, eventProperties, streamId);
}

async function settle(promise) {
  try {
    return { outcome: "resolve", value: await promise };
  } catch (reason) {
    return { outcome: "reject", value: reason };
  }
}

async function runSequence(inspector, steps, fixtureId) {
  if (!Array.isArray(steps)) configError(fixtureId, "sequence operation requires a steps array");
  const actual = [];
  for (const step of steps) {
    const action = step && step.action;
    if (action === "track") {
      const result = await settle(
        callTrack(inspector, step.eventName, step.eventProperties, step.streamId, step.options)
      );
      actual.push({ action, outcome: result.outcome, value: result.value });
    } else if (action === "trackN") {
      const count = step.count;
      if (!Number.isInteger(count) || count < 1) configError(fixtureId, "trackN requires an integer count >= 1");
      const prefix = step.eventNamePrefix ?? "";
      const streamId = step.streamId ?? "";
      // Single-threaded Node: concurrently scheduled tasks, joined together.
      const tasks = [];
      for (let i = 0; i < count; i += 1) {
        tasks.push(inspector.trackSchemaFromEvent(`${prefix}${i}`, {}, streamId));
      }
      await Promise.all(tasks);
      actual.push({ action, outcome: "resolve", value: count });
    } else if (action === "flush") {
      await (step.timeoutMs === undefined ? inspector.flush() : inspector.flush(step.timeoutMs));
      actual.push({ action, outcome: "resolve", value: null });
    } else if (action === "destroy") {
      inspector.destroy();
      actual.push({ action, outcome: "resolve", value: null });
    } else {
      configError(fixtureId, `unsupported sequence action: ${action}`);
    }
  }
  return actual;
}

async function main() {
  let envelope;
  try {
    envelope = JSON.parse((await readStdin()).trim());
  } catch (err) {
    configError(null, `input JSON parse failed: ${err.message}`);
  }
  if (envelope === null || typeof envelope !== "object" || Array.isArray(envelope)) {
    configError(null, "input envelope must be a JSON object");
  }

  const fixtureId = envelope.fixture_id;
  if (typeof fixtureId !== "string") configError(fixtureId, "missing fixture_id");
  const operation =
    envelope.operation ?? (envelope.suite === "schema-extraction" ? "extractSchema" : undefined);

  // `envelope.constructor` would otherwise resolve to the inherited Object function.
  const options = Object.prototype.hasOwnProperty.call(envelope, "constructor")
    ? envelope.constructor
    : undefined;
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    configError(fixtureId, "missing or invalid constructor object");
  }

  let inspector;
  try {
    inspector = new AvoInspector(options);
  } catch (err) {
    exitWith(1, { fixture_id: fixtureId, passed: false, actual: null, outcome: "resolve", error: `Constructor threw: ${err.message}` });
  }

  try {
    applyPrecondition(inspector, envelope.precondition, fixtureId);

    if (operation === "extractSchema") {
      const actual = inspector.extractSchema(envelope.input);
      exitWith(0, { fixture_id: fixtureId, passed: true, actual, outcome: "resolve", error: null });
    }
    if (operation === "trackSchemaFromEvent") {
      const input = envelope.input || {};
      const result = await settle(
        callTrack(inspector, input.eventName, input.eventProperties, input.streamId, input.options)
      );
      exitWith(0, { fixture_id: fixtureId, passed: true, actual: result.value, outcome: result.outcome, error: null });
    }
    if (operation === "sequence") {
      const actual = await runSequence(inspector, envelope.steps, fixtureId);
      exitWith(0, { fixture_id: fixtureId, passed: true, actual, outcome: "resolve", error: null });
    }
    configError(fixtureId, `unsupported operation: ${operation}`);
  } catch (err) {
    if (err === EXITING) throw err;
    exitWith(1, { fixture_id: fixtureId, passed: false, actual: null, outcome: "resolve", error: `harness runtime error: ${err && err.message}` });
  }
}

main().catch((err) => {
  if (err !== EXITING) throw err;
});

module.exports = { HARNESS_CONTRACT_VERSION };
