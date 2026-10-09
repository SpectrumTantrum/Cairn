// Pure-logic gate for the agentic Ask progress panel. The React rendering has no
// node harness; this locks the elapsed clock, the live step list, and the
// "still working" copy. That copy must not imply the run is faster.

import assert from "node:assert/strict";
import { test } from "node:test";

const {
  AGENTIC_WORKING_LABEL,
  formatElapsed,
  initialAgenticProgress,
  reduceAgenticProgress,
  buildProgressView,
} = await import("../out-test/agentic-progress.js");

const SPEED_WORDS = ["faster", "quick", "soon", "almost", "nearly"];

function viewText(view) {
  return [view.workingLabel, view.elapsedText, view.status, ...view.steps.map((step) => step.label)]
    .join(" ")
    .toLowerCase();
}

test("a new run starts at 0:00 with the working label and no steps", () => {
  const view = buildProgressView(initialAgenticProgress(1_000), 1_000);
  assert.equal(view.workingLabel, "Still working");
  assert.equal(view.elapsedText, "0:00 elapsed");
  assert.equal(view.status, "Searching your notes with tools…");
  assert.equal(view.showStatus, true);
  assert.deepEqual(view.steps, []);
});

test("formatElapsed floors to m:ss and h:mm:ss", () => {
  assert.equal(formatElapsed(0), "0:00");
  assert.equal(formatElapsed(4_999), "0:04");
  assert.equal(formatElapsed(5_000), "0:05");
  assert.equal(formatElapsed(125_000), "2:05");
  assert.equal(formatElapsed(3_600_000), "1:00:00");
  assert.equal(formatElapsed(3_661_000), "1:01:01");
  assert.equal(formatElapsed(-20), "0:00");
});

test("progress view shows still working, elapsed time, and live steps", () => {
  const started = 1_000_000;
  let state = initialAgenticProgress(started);
  state = reduceAgenticProgress(state, {
    kind: "status",
    message: "Waiting for the model to call search tools…",
  });
  state = reduceAgenticProgress(state, {
    kind: "tool",
    step: 1,
    name: "grep",
    label: "Grepped for Section B",
  });
  state = reduceAgenticProgress(state, {
    kind: "status",
    message: "Thinking (step 2)…",
  });
  state = reduceAgenticProgress(state, {
    kind: "tool",
    step: 2,
    name: "read",
    label: "Read project-heron.md",
  });

  const view = buildProgressView(state, started + 134_000);
  assert.equal(view.workingLabel, AGENTIC_WORKING_LABEL);
  assert.equal(view.workingLabel, "Still working");
  assert.equal(view.elapsedText, "2:14 elapsed");
  assert.deepEqual(
    view.steps.map((step) => ({ label: step.label, current: step.current })),
    [
      { label: "Grepped for Section B", current: false },
      { label: "Read project-heron.md", current: true },
    ],
  );
  assert.equal(view.showStatus, false);
  for (const word of SPEED_WORDS) {
    assert.equal(viewText(view).includes(word), false, word);
  }
});

test("reducer keeps startedAt and a composing status marks every step done", () => {
  const started = 50;
  let state = initialAgenticProgress(started);
  state = reduceAgenticProgress(state, {
    kind: "tool",
    step: 1,
    name: "find",
    label: "Searched for copper finch",
  });
  assert.equal(state.startedAt, started);
  state = reduceAgenticProgress(state, { kind: "status", message: "Composing answer…" });
  assert.equal(state.startedAt, started);
  assert.deepEqual(state.steps, ["Searched for copper finch"]);

  const view = buildProgressView(state, started + 5_000);
  assert.equal(view.elapsedText, "0:05 elapsed");
  assert.equal(view.showStatus, true);
  assert.equal(view.status, "Composing answer…");
  assert.equal(
    view.steps.every((step) => step.current === false),
    true,
  );
  for (const word of SPEED_WORDS) {
    assert.equal(viewText(view).includes(word), false, word);
  }
});

test("the latest step is current only while the status equals its label", () => {
  const running = reduceAgenticProgress(initialAgenticProgress(0), {
    kind: "tool",
    step: 1,
    name: "grep",
    label: "Grepped for Section B",
  });
  const duringTool = buildProgressView(running, 1_000);
  assert.equal(duringTool.steps[0].current, true);
  assert.equal(duringTool.showStatus, false);
  assert.equal(duringTool.elapsedText, "0:01 elapsed");

  const thinking = buildProgressView(
    reduceAgenticProgress(running, { kind: "status", message: "Thinking (step 2)…" }),
    2_000,
  );
  assert.equal(thinking.steps[0].current, false);
  assert.equal(thinking.showStatus, true);
  assert.equal(thinking.status, "Thinking (step 2)…");
  assert.equal(thinking.workingLabel, "Still working");
});
