import { useCallback, useEffect, useRef, useState } from "react";

interface ResizableOpts {
  storageKey: string;
  initial: number;
  min: number;
  max: number;
  /** "left" rail grows as the pointer moves right; "right" rail grows moving left. */
  edge: "left" | "right";
}

/** Pointer-driven pane resize with min/max clamping and localStorage persistence. */
export function useResizable({ storageKey, initial, min, max, edge }: ResizableOpts) {
  const [width, setWidth] = useState<number>(() => {
    const stored = Number(window.localStorage.getItem(storageKey));
    return Number.isFinite(stored) && stored >= min && stored <= max ? stored : initial;
  });
  const [dragging, setDragging] = useState(false);
  const startX = useRef(0);
  const startW = useRef(0);

  useEffect(() => {
    window.localStorage.setItem(storageKey, String(Math.round(width)));
  }, [storageKey, width]);

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

  return { width, dragging, onPointerDown };
}
