// Focus order for the markdown editor. Kept pure of React so a node test can
// lock two rules that otherwise only show up in the live editor:
//   - a vault-tree open focuses the editor
//   - a citation open focuses only after the caret is on the target line
// Focusing a brand-new EditorView scrolls its line-1 caret into view. Doing
// that on a citation open pulls the viewport back to the top after the land.

import type { EditorView } from "@codemirror/view";
import { clampCitationLine } from "./agent-citations.js";

export interface EditorFlash {
  line: number;
  nonce: number;
  highlight: boolean;
}

/**
 * Flash stored for this editor open.
 * A citation open records its own line. A vault-tree open has no target and
 * returns null, dropping a leftover chip flash so the new note does not land
 * on the previous line.
 */
export function nextEditorFlash(
  flashTarget: { line: number; highlight: boolean } | undefined,
  nonce: number,
): EditorFlash | null {
  if (!flashTarget) return null;
  return { line: flashTarget.line, highlight: flashTarget.highlight, nonce };
}

/** True when this open is not a citation land, so the new editor may focus immediately. */
export function focusEditorOnMount(view: { focus(): void }, flash: { line: number } | null): void {
  if (flash == null) view.focus();
}

/**
 * Put the caret on `lineNo` (clamped), apply highlight and scroll effects, then focus.
 * Focus is last so it cannot scroll a line-1 caret back over the landed line.
 */
export function landCitation(
  view: EditorView,
  lineNo: number,
  highlight: boolean,
  effects: (
    landed: { line: number; from: number },
    highlight: boolean,
  ) => NonNullable<Parameters<EditorView["dispatch"]>[0]["effects"]>,
): number {
  const line = clampCitationLine(lineNo, view.state.doc.lines);
  const from = view.state.doc.line(line).from;
  view.dispatch({
    selection: { anchor: from },
    effects: effects({ line, from }, highlight),
  });
  view.focus();
  return line;
}
