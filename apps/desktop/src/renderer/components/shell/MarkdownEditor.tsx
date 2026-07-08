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

interface MarkdownEditorProps {
  /** Identity of the open document; changing it resets the editor state. */
  docKey: string;
  /** Initial content for this docKey (last-saved buffer). */
  initialDoc: string;
  /** Citation target: 1-based line to scroll to + flash. `nonce` re-triggers the same line. */
  flash: { line: number; nonce: number } | null;
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
  onChange,
  onSave,
  onCursor,
}: MarkdownEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  // Keep latest callbacks without re-creating the editor.
  const cbs = useRef({ onChange, onSave, onCursor });
  cbs.current = { onChange, onSave, onCursor };

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
    view.focus();
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // Reset only on document identity change, not on every keystroke/prop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docKey]);

  // Apply a citation flash: scroll the line into view, highlight it, then clear.
  useEffect(() => {
    const view = viewRef.current;
    if (!view || flash === null) return;
    const lineNo = Math.max(1, Math.min(flash.line, view.state.doc.lines));
    const line = view.state.doc.line(lineNo);
    view.dispatch({
      effects: [setFlash.of(flash.line), EditorView.scrollIntoView(line.from, { y: "center" })],
    });
    const timer = window.setTimeout(() => {
      viewRef.current?.dispatch({ effects: setFlash.of(null) });
    }, 1400);
    return () => window.clearTimeout(timer);
    // Re-run when either the target changes or the nonce bumps (same-line re-cite).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flash?.line, flash?.nonce, docKey]);

  return <div className="cm-host" ref={hostRef} />;
}
