// QA on the land-at-line editor: the flash must beat the active-line background
// in both CodeMirror themes, a vault-tree open must focus the editor, and a
// chip open must focus only after the caret is on the target line.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const { focusEditorOnMount, landCitation, nextEditorFlash } = await import(
  "../out-test/citation-editor-focus.js"
);

function fakeEditor(docLines) {
  let line = 1;
  const ops = [];
  return {
    ops,
    state: {
      doc: {
        lines: docLines,
        line(n) {
          return { from: n, number: n };
        },
      },
    },
    dispatch(spec) {
      line = spec.selection.anchor;
      ops.push({ op: "select", line });
    },
    focus() {
      ops.push({ op: "focus", line });
    },
  };
}

test("a tree open focuses the editor", () => {
  const view = fakeEditor(80);
  focusEditorOnMount(view, null);
  assert.deepEqual(view.ops, [{ op: "focus", line: 1 }]);
});

test("a tree open after a citation drops the previous line and focuses the editor", () => {
  const leftover = nextEditorFlash({ line: 47, highlight: true }, 3);
  assert.deepEqual(leftover, { line: 47, highlight: true, nonce: 3 });
  const treeFlash = nextEditorFlash(undefined, leftover.nonce);
  assert.equal(treeFlash, null);
  const view = fakeEditor(80);
  focusEditorOnMount(view, treeFlash);
  assert.deepEqual(view.ops, [{ op: "focus", line: 1 }]);
});

test("a chip open focuses the editor and stays on the target line", () => {
  const view = fakeEditor(80);
  focusEditorOnMount(view, { line: 47, highlight: true });
  assert.deepEqual(view.ops, [], "mount focus would scroll the line-1 caret");
  const landed = landCitation(view, 47, true, () => []);
  assert.equal(landed, 47);
  assert.deepEqual(view.ops, [
    { op: "select", line: 47 },
    { op: "focus", line: 47 },
  ]);
});

/** [ids, classes+attrs+pseudos, elements]. A tie does not win. */
function specificity(selector) {
  const ids = (selector.match(/#[\w-]+/g) || []).length;
  const classes =
    (selector.match(/\.[\w\\-]+/g) || []).length +
    (selector.match(/\[[^\]]+\]/g) || []).length +
    (selector.match(/:(?!:)[\w-]+(\([^)]*\))?/g) || []).length;
  const stripped = selector
    .replace(/#[\w-]+/g, " ")
    .replace(/\.[\w\\-]+/g, " ")
    .replace(/\[[^\]]+\]/g, " ")
    .replace(/:(?!:)[\w-]+(\([^)]*\))?/g, " ")
    .replace(/[+>~]/g, " ");
  const elements = stripped.split(/\s+/).filter((token) => token && token !== "*").length;
  return [ids, classes, elements];
}

function beats(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

function classTokens(selector) {
  return selector.match(/\.[\w\\-]+/g)?.map((token) => token.slice(1)) ?? [];
}

/** Descendant class selectors only — enough for the flash rule and the active-line rules. */
function matches(selector, node) {
  const own = new Set(node.classes);
  const ancestors = node.ancestors.map((classes) => new Set(classes));
  const compounds = selector.trim().split(/\s+/).map(classTokens);
  if (compounds.some((tokens) => tokens.length === 0)) return false;
  const last = compounds[compounds.length - 1];
  if (!last.every((token) => own.has(token))) return false;
  let depth = ancestors.length - 1;
  for (let i = compounds.length - 2; i >= 0; i -= 1) {
    const need = compounds[i];
    let found = false;
    while (depth >= 0) {
      const have = ancestors[depth];
      depth -= 1;
      if (need.every((token) => have.has(token))) {
        found = true;
        break;
      }
    }
    if (!found) return false;
  }
  return true;
}

function flashRule() {
  const css = readFileSync(new URL("../src/renderer/styles.css", import.meta.url), "utf8").replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );
  const match = css.match(/([^{}]*\.cm-flash-line[^{}]*)\{([^}]+)\}/);
  assert.ok(match, "styles.css has a .cm-flash-line rule");
  return { selector: match[1].trim(), body: match[2] };
}

// CodeMirror's base theme compiles `&light .cm-activeLine` and `&dark .cm-activeLine`
// to a two-class selector each. The editor theme's `.cm-activeLine` is the same weight.
const ACTIVE_LINE = [
  { selector: ".cm-lightId .cm-activeLine", background: "#cceeff44", theme: "light" },
  { selector: ".cm-darkId .cm-activeLine", background: "#99eeff33", theme: "dark" },
  { selector: ".cm-themeId .cm-activeLine", background: "rgba(255, 255, 255, 0.02)", theme: "both" },
];

function lineNode(themeId) {
  return {
    classes: ["cm-line", "cm-activeLine", "cm-flash-line"],
    ancestors: [["cm-editor", "cm-focused", themeId, "cm-themeId"]],
  };
}

test("citation flash overrides the active-line background in light and dark themes", () => {
  const flash = flashRule();
  const flashSpec = specificity(flash.selector);
  for (const active of ACTIVE_LINE) {
    assert.ok(
      beats(flashSpec, specificity(active.selector)),
      `${flash.selector} ${flashSpec} should beat ${active.selector}`,
    );
  }

  const declared = flash.body.match(/background-color:\s*rgba\(\s*111\s*,\s*155\s*,\s*239\s*,\s*([0-9.]+)\s*\)/);
  assert.ok(declared, "flash sets an explicit background-color");
  const alpha = Number(declared[1]);
  assert.ok(alpha >= 0.4, `flash alpha ${alpha} should read over the faint active-line wash`);
  assert.doesNotMatch(flash.body, /#cceeff44|#99eeff33|rgba\(\s*255\s*,\s*255\s*,\s*255\s*,\s*0\.02\s*\)|--accent-fill/);

  for (const themeId of ["cm-lightId", "cm-darkId"]) {
    const node = lineNode(themeId);
    assert.equal(matches(flash.selector, node), true, flash.selector);
    const matching = ACTIVE_LINE.filter((active) => matches(active.selector, node));
    assert.ok(matching.length >= 1, `${themeId} still has an active-line rule`);
    for (const active of matching) {
      assert.ok(beats(flashSpec, specificity(active.selector)));
      assert.notEqual(flash.body.includes(active.background), true);
    }
  }
});
