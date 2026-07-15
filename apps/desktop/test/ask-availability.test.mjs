// Pure-logic gate for the Ask composer-disabled copy (issue #14). Locks the exact string each
// unavailable state shows, in priority order. The load-bearing assertion is the Ollama-down
// case: it must reassure the user that vault SEARCH still works without AI, and keep the
// local-first "no cloud calls" line. The React wiring (warn styling, render slot) is verified
// via the build gate + manual notes; this locks the decision the copy is built on.

import assert from "node:assert/strict";
import { test } from "node:test";

const { composerDisabledReason } = await import("../out-test/ask-availability.js");

const ready = { hasVault: true, indexed: true, ollamaUp: true };

test("all signals green → Ask is available (null reason)", () => {
  assert.equal(composerDisabledReason(ready), null);
});

test("no vault → prompts to choose a vault", () => {
  assert.equal(
    composerDisabledReason({ ...ready, hasVault: false }),
    "Choose a vault to ask grounded questions.",
  );
});

test("not indexed → prompts to index first", () => {
  assert.equal(
    composerDisabledReason({ ...ready, indexed: false }),
    "Index this vault before asking (status bar, bottom of the editor).",
  );
});

test("Ollama down → says search still works without AI and keeps the no-cloud line", () => {
  const reason = composerDisabledReason({ ...ready, ollamaUp: false });
  assert.match(reason, /search still works without AI/i);
  assert.match(reason, /No cloud calls are ever made/i);
});

test("priority: no vault beats not-indexed and Ollama-down", () => {
  assert.equal(
    composerDisabledReason({ hasVault: false, indexed: false, ollamaUp: false }),
    "Choose a vault to ask grounded questions.",
  );
});

test("priority: not-indexed beats Ollama-down", () => {
  assert.equal(
    composerDisabledReason({ hasVault: true, indexed: false, ollamaUp: false }),
    "Index this vault before asking (status bar, bottom of the editor).",
  );
});
