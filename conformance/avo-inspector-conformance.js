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

// The suite identifiers of runner-contract.md; operations and step actions are checked
// against their own sets in validateEnvelope and validateStep.
const SUITES = ["schema-extraction", "wire-protocol", "error-handling", "batching"];

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

// Every envelope field the harness reads is checked here; a malformed one is a configuration
// error (exit 2). Values the SDK itself is under test for (constructor fields, option values,
// property values) are passed through verbatim.
function validatePrecondition(envelope, fixtureId) {
  if (!has(envelope, "precondition")) return;
  const precondition = envelope.precondition;
  if (!isObject(precondition)) configError(fixtureId, "precondition must be an object");
  for (const key of Object.keys(precondition)) {
    if (key !== "samplingRate") configError(fixtureId, `unsupported precondition field: ${key}`);
  }
  if (has(precondition, "samplingRate")) {
    const rate = precondition.samplingRate;
    if (typeof rate !== "number" || !Number.isFinite(rate) || rate < 0 || rate > 1) {
      configError(fixtureId, "precondition.samplingRate must be a number from 0 to 1");
    }
  }
}

// The fields of one trackSchemaFromEvent call, from `input` or a `track` step.
function validateTrackArgs(source, where, fixtureId) {
  if (typeof source.eventName !== "string") configError(fixtureId, `${where}.eventName must be a string`);
  if (!isObject(source.eventProperties)) configError(fixtureId, `${where}.eventProperties must be an object`);
  if (has(source, "streamId") && typeof source.streamId !== "string") {
    configError(fixtureId, `${where}.streamId must be a string`);
  }
  if (has(source, "options") && !isObject(source.options)) {
    configError(fixtureId, `${where}.options must be an object`);
  }
}

function validateStep(step, index, fixtureId) {
  const where = `steps[${index}]`;
  if (!isObject(step)) configError(fixtureId, `${where} must be an object`);
  const action = step.action;
  if (action === "track") {
    validateTrackArgs(step, where, fixtureId);
  } else if (action === "trackN") {
    if (!Number.isInteger(step.count) || step.count < 1) {
      configError(fixtureId, `${where}: trackN requires an integer count >= 1`);
    }
    for (const key of ["eventNamePrefix", "streamId"]) {
      if (has(step, key) && typeof step[key] !== "string") configError(fixtureId, `${where}.${key} must be a string`);
    }
  } else if (action === "flush") {
    if (has(step, "timeoutMs") && !(Number.isInteger(step.timeoutMs) && step.timeoutMs >= 0)) {
      configError(fixtureId, `${where}.timeoutMs must be an integer >= 0`);
    }
  } else if (action !== "destroy") {
    configError(fixtureId, `unsupported sequence action: ${action}`);
  }
}

// Returns the operation to run once the whole envelope has been checked.
function validateEnvelope(envelope) {
  const fixtureId = envelope.fixture_id;
  if (typeof fixtureId !== "string") configError(null, "fixture_id must be a string");
  if (!SUITES.includes(envelope.suite)) {
    configError(fixtureId, `suite must be one of ${SUITES.join(", ")}`);
  }
  if (has(envelope, "operation") && typeof envelope.operation !== "string") {
    configError(fixtureId, "operation must be a string");
  }
  const operation =
    envelope.operation ?? (envelope.suite === "schema-extraction" ? "extractSchema" : undefined);
  if (operation === undefined) configError(fixtureId, "missing operation");

  // `envelope.constructor` would otherwise resolve to the inherited Object function.
  if (!has(envelope, "constructor") || !isObject(envelope.constructor)) {
    configError(fixtureId, "missing or invalid constructor object");
  }

  if (operation === "extractSchema") {
    // `input` IS eventProperties and MAY be null (fixture-8).
    if (!has(envelope, "input") || !(envelope.input === null || isObject(envelope.input))) {
      configError(fixtureId, "extractSchema requires an input object or null");
    }
  } else if (operation === "trackSchemaFromEvent") {
    if (!isObject(envelope.input)) configError(fixtureId, "trackSchemaFromEvent requires an input object");
    validateTrackArgs(envelope.input, "input", fixtureId);
  } else if (operation === "sequence") {
    if (!Array.isArray(envelope.steps)) configError(fixtureId, "sequence operation requires a steps array");
    envelope.steps.forEach((step, index) => validateStep(step, index, fixtureId));
  } else {
    configError(fixtureId, `unsupported operation: ${operation}`);
  }

  validatePrecondition(envelope, fixtureId);
  return operation;
}

// The fixture's track input as one InspectorEvent: a streamId the fixture does not supply
// stays absent, and the gateway options are spread in verbatim.
function callTrack(inspector, eventName, eventProperties, streamId, options) {
  const event = { eventName, eventProperties };
  if (streamId !== undefined) {
    event.streamId = streamId;
  }
  return inspector.trackSchemaFromEvent(options !== undefined ? { ...event, ...options } : event);
}

async function settle(promise) {
  try {
    return { outcome: "resolve", value: await promise };
  } catch (reason) {
    return { outcome: "reject", value: reason };
  }
}

// Steps were validated by validateEnvelope before the instance was built.
async function runSequence(inspector, steps) {
  const actual = [];
  for (const step of steps) {
    const action = step.action;
    if (action === "track") {
      const result = await settle(
        callTrack(inspector, step.eventName, step.eventProperties, step.streamId, step.options)
      );
      actual.push({ action, outcome: result.outcome, value: result.value });
    } else if (action === "trackN") {
      const count = step.count;
      const prefix = step.eventNamePrefix ?? "";
      const streamId = step.streamId ?? "";
      // Single-threaded Node: concurrently scheduled tasks, joined together.
      const tasks = [];
      for (let i = 0; i < count; i += 1) {
        tasks.push(inspector.trackSchemaFromEvent({ eventName: `${prefix}${i}`, eventProperties: {}, streamId }));
      }
      await Promise.all(tasks);
      actual.push({ action, outcome: "resolve", value: count });
    } else if (action === "flush") {
      const drained = await (step.timeoutMs === undefined ? inspector.flush() : inspector.flush(step.timeoutMs));
      actual.push({ action, outcome: "resolve", value: drained });
    } else {
      inspector.destroy();
      actual.push({ action, outcome: "resolve", value: null });
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
  if (!isObject(envelope)) {
    configError(null, "input envelope must be a JSON object");
  }

  const operation = validateEnvelope(envelope);
  const fixtureId = envelope.fixture_id;

  let inspector;
  try {
    inspector = new AvoInspector(envelope.constructor);
  } catch (err) {
    exitWith(1, { fixture_id: fixtureId, passed: false, actual: null, outcome: "resolve", error: `Constructor threw: ${err.message}` });
  }

  try {
    if (envelope.precondition && has(envelope.precondition, "samplingRate")) {
      inspector._setSamplingRateForTesting(envelope.precondition.samplingRate);
    }

    if (operation === "extractSchema") {
      const actual = inspector.extractSchema(envelope.input);
      exitWith(0, { fixture_id: fixtureId, passed: true, actual, outcome: "resolve", error: null });
    }
    if (operation === "trackSchemaFromEvent") {
      const input = envelope.input;
      const result = await settle(
        callTrack(inspector, input.eventName, input.eventProperties, input.streamId, input.options)
      );
      exitWith(0, { fixture_id: fixtureId, passed: true, actual: result.value, outcome: result.outcome, error: null });
    }
    if (operation === "sequence") {
      const actual = await runSequence(inspector, envelope.steps);
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
