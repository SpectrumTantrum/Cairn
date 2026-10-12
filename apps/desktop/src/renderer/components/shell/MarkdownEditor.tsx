import { useEffect, useRef } from "react";
import { EditorState, StateEffect, StateField } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
} from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import {
  syntaxHighlighting,
  HighlightStyle,
  bracketMatching,
  indentOnInput,
} from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { focusEditorOnMount, landCitation } from "../../citation-editor-focus";

/** Citation scroll target. `highlight` is false for a whole-file chip. */
export interface CitationFlash {
  line: number;
  nonce: number;
  highlight: boolean;
}

interface MarkdownEditorProps {
  /** Identity of the open document; changing it resets the editor state. */
  docKey: string;
  /** Initial content for this docKey (last-saved buffer). */
  initialDoc: string;
  /** Citation target: 1-based line to scroll to. `nonce` re-triggers the same line. */
  flash: CitationFlash | null;
  /** Plain text is shown at the cited line and is not a write target. */
  readOnly?: boolean;
  onChange(value: string): void;
  onSave(): void;
  onCursor(pos: { line: number; col: number }): void;
}

/* ---- Dark theme matching the app tokens ---- */

const cairnTheme = EditorView.theme(
  {
    "&": {
      color: "var(--text)",
      backgroundColor: "var(--pane-editor)",
      fontSize: "14px",
      height: "100%",
    },
    ".cm-scroller": {
      fontFamily: "var(--font-ui)",
      lineHeight: "1.6",
      padding: "26px 34px",
    },
    ".cm-content": { caretColor: "var(--accent)", maxWidth: "820px" },
    "&.cm-focused": { outline: "none" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
      backgroundColor: "rgba(111, 155, 239, 0.22)",
    },
    ".cm-gutters": {
      backgroundColor: "var(--pane-editor)",
      color: "var(--text-faint)",
      border: "none",
      paddingRight: "8px",
    },
    ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--text-muted)" },
    ".cm-activeLine": { backgroundColor: "rgba(255,255,255,0.02)" },
    ".cm-lineNumbers .cm-gutterElement": { minWidth: "28px" },
  },
  { dark: true },
);

const cairnHighlight = HighlightStyle.define([
  { tag: t.heading, color: "var(--text-strong)", fontWeight: "700" },
  { tag: t.strong, color: "var(--text-strong)", fontWeight: "700" },
  { tag: t.emphasis, color: "var(--text-strong)", fontStyle: "italic" },
  { tag: [t.link, t.url], color: "var(--accent)" },
  { tag: t.monospace, color: "var(--accent-strong)", fontFamily: "var(--font-mono)" },
  { tag: [t.list, t.quote], color: "var(--text-muted)" },
  { tag: [t.processingInstruction, t.meta], color: "var(--text-faint)" },
]);

/* ---- Citation flash: a temporary line decoration ---- */

const setFlash = StateEffect.define<number | null>();
const flashDeco = Decoration.line({ class: "cm-flash-line" });

function applyCitationFlash(view: EditorView, lineNo: number, highlight: boolean): void {
  landCitation(view, lineNo, highlight, (landed, hl) => [
    setFlash.of(hl ? landed.line : null),
    EditorView.scrollIntoView(landed.from, { y: "center" }),
  ]);
}

const flashField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setFlash)) {
        if (e.value === null) return Decoration.none;
        const lineNo = Math.max(1, Math.min(e.value, tr.state.doc.lines));
        const line = tr.state.doc.line(lineNo);
        return Decoration.set([flashDeco.range(line.from)]);
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

export function MarkdownEditor({
  docKey,
  initialDoc,
  flash,
  readOnly = false,
  onChange,
  onSave,
  onCursor,
}: MarkdownEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  // Keep latest callbacks without re-creating the editor.
  const cbs = useRef({ onChange, onSave, onCursor });
  cbs.current = { onChange, onSave, onCursor };
  // The create effect only re-runs when docKey changes. Read the flash from
  // this render so a citation open in the same commit is not focused at line 1.
  const flashRef = useRef(flash);
  flashRef.current = flash;

  // Build a fresh EditorView whenever the open document changes.
  useEffect(() => {
    if (!hostRef.current) return;

    const saveKeymap = keymap.of([
      {
        key: "Mod-s",
        preventDefault: true,
        run: () => {
          cbs.current.onSave();
          return true;
        },
      },
    ]);

    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: initialDoc,
        extensions: [
          lineNumbers(),
          history(),
          indentOnInput(),
          bracketMatching(),
          highlightActiveLine(),
          highlightActiveLineGutter(),
          markdown(),
          syntaxHighlighting(cairnHighlight),
          flashField,
          EditorState.readOnly.of(readOnly),
          EditorView.editable.of(!readOnly),
          cairnTheme,
          EditorView.lineWrapping,
          saveKeymap,
          keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) {
              cbs.current.onChange(u.state.doc.toString());
            }
            if (u.selectionSet || u.docChanged) {
              const head = u.state.selection.main.head;
              const line = u.state.doc.lineAt(head);
              cbs.current.onCursor({ line: line.number, col: head - line.from + 1 });
            }
          }),
        ],
      }),
    });
    viewRef.current = view;
    // Tree opens have no flash: focus so the caret is ready to type.
    // A chip, Sources, or search open already has a flash. Focusing now would
    // scroll the fresh line-1 caret into view over the landed line. That path
    // focuses inside landCitation, after the caret has moved.
    focusEditorOnMount(view, flashRef.current);
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // Reset only on document identity change, not on every keystroke/prop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docKey]);

  // Apply a citation flash: move caret, scroll the line into view, highlight, then clear.
  useEffect(() => {
    const view = viewRef.current;
    if (!view || flash === null) return;
    const lineNo = flash.line;
    const highlight = flash.highlight;
    let alive = true;
    let cleared = false;
    const run = () => {
      if (!alive || !viewRef.current) return;
      applyCitationFlash(viewRef.current, lineNo, highlight && !cleared);
    };
    run();
    // Layout may not be ready on first paint after docKey swap (loading → editor).
    const raf = requestAnimationFrame(() => requestAnimationFrame(run));
    const measure = (attempts: number) => {
      const current = viewRef.current;
      if (!alive || !current) return;
      current.requestMeasure({
        key: "citation-flash",
        read: (v) => v.scrollDOM.clientHeight,
        write: (height, v) => {
          if (!alive || viewRef.current !== v) return;
          if (height > 0) {
            requestAnimationFrame(run);
            return;
          }
          if (attempts >= 8) return;
          requestAnimationFrame(() => measure(attempts + 1));
        },
      });
    };
    measure(0);
    const timer = window.setTimeout(() => {
      cleared = true;
      if (alive) viewRef.current?.dispatch({ effects: setFlash.of(null) });
    }, 1400);
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      window.clearTimeout(timer);
    };
    // Re-run when either the target changes or the nonce bumps (same-line re-cite).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flash?.line, flash?.nonce, flash?.highlight, docKey]);

  return <div className="cm-host" ref={hostRef} />;
}
