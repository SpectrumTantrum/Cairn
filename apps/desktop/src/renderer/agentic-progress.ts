/**
 * Live progress for an in-flight agentic Ask run.
 * Pure state (no React) so the elapsed clock and step list can be unit-tested.
 * Copy reports that the run is still going and how long it has taken. It does
 * not estimate remaining time or describe the run as faster.
 */

/** Shown for the whole run, including long quiet stretches between tool steps. */
export const AGENTIC_WORKING_LABEL = "Still working";

export const INITIAL_AGENTIC_STATUS = "Searching your notes with tools…";

/** Same shape as the engine's AskAgentProgress, kept local so this module stays testable. */
export type AgenticProgressEvent =
  | { kind: "status"; message: string }
  | { kind: "tool"; step: number; name: string; label: string };

export type AgenticProgressState = {
  steps: string[];
  status: string;
  /** `Date.now()` when the streaming turn was created. */
  startedAt: number;
};

export type ProgressStepView = {
  label: string;
  /** True only while this is the latest step and the status line is that same label. */
  current: boolean;
};

export type ProgressView = {
  workingLabel: string;
  /** Clock text such as "2:14 elapsed". */
  elapsedText: string;
  status: string;
  /** False when `status` repeats the current step, so the panel does not print it twice. */
  showStatus: boolean;
  steps: ProgressStepView[];
};

export function initialAgenticProgress(now: number): AgenticProgressState {
  return { steps: [], status: INITIAL_AGENTIC_STATUS, startedAt: now };
}

/** Floor to whole seconds. `m:ss`, or `h:mm:ss` once an hour has passed. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const ss = String(seconds).padStart(2, "0");
  if (hours > 0) {
    const mm = String(minutes).padStart(2, "0");
    return `${hours}:${mm}:${ss}`;
  }
  return `${minutes}:${ss}`;
}

export function reduceAgenticProgress(
  state: AgenticProgressState,
  event: AgenticProgressEvent,
): AgenticProgressState {
  if (event.kind === "status") {
    return { ...state, status: event.message };
  }
  return {
    ...state,
    steps: [...state.steps, event.label],
    status: event.label,
  };
}

export function buildProgressView(state: AgenticProgressState, now: number): ProgressView {
  const steps = state.steps.map((label, index) => ({
    label,
    current: index === state.steps.length - 1 && state.status === label,
  }));
  const current = steps.find((step) => step.current);
  return {
    workingLabel: AGENTIC_WORKING_LABEL,
    elapsedText: `${formatElapsed(now - state.startedAt)} elapsed`,
    status: state.status,
    showStatus: state.status.length > 0 && current?.label !== state.status,
    steps,
  };
}
