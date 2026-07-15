import { useCallback, useEffect, useRef, useState } from "react";
import { readPaneWidth, writePaneWidth, type PaneWidthSpec } from "../../settings";

interface ResizableOpts {
  /** Persisted-width contract (key + default + clamp bounds) from the settings module. */
  spec: PaneWidthSpec;
  /** "left" rail grows as the pointer moves right; "right" rail grows moving left. */
  edge: "left" | "right";
}

/** Pointer-driven pane resize with min/max clamping and localStorage persistence. */
export function useResizable({ spec, edge }: ResizableOpts) {
  const { initial, min, max } = spec;
  const [width, setWidth] = useState<number>(() => readPaneWidth(window.localStorage, spec));
  const [dragging, setDragging] = useState(false);
  const startX = useRef(0);
  const startW = useRef(0);

  useEffect(() => {
    writePaneWidth(window.localStorage, spec, width);
  }, [spec, width]);

  /** Snap back to the default width (the settings panel's "reset layout" control). */
  const reset = useCallback(() => setWidth(initial), [initial]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      startX.current = e.clientX;
      startW.current = width;
      setDragging(true);
    },
    [width],
  );

  useEffect(() => {
    if (!dragging) return;
    function onMove(e: PointerEvent): void {
      const delta = e.clientX - startX.current;
      const next = edge === "left" ? startW.current + delta : startW.current - delta;
      setWidth(Math.max(min, Math.min(max, next)));
    }
    function onUp(): void {
      setDragging(false);
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [dragging, edge, min, max]);

  return { width, dragging, onPointerDown, reset };
}
