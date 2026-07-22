import { useState, useRef, useCallback, useEffect } from "react";

export default function SplitPane({ left, right, defaultWidth = 280, minWidth = 200, maxWidth = "60%" }) {
  const [width, setWidth] = useState(defaultWidth);
  const containerRef = useRef(null);
  const dragging = useRef(false);

  const handleMouseDown = useCallback((e) => {
    e.preventDefault();
    dragging.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, []);

  useEffect(() => {
    const handleMouseMove = (e) => {
      if (!dragging.current || !containerRef.current) return;

      const rect = containerRef.current.getBoundingClientRect();
      const maxPx = typeof maxWidth === "string"
        ? rect.width * (parseInt(maxWidth) / 100)
        : maxWidth;

      const newWidth = Math.min(Math.max(e.clientX - rect.left, minWidth), maxPx);
      setWidth(newWidth);
    };

    const handleMouseUp = () => {
      if (dragging.current) {
        dragging.current = false;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      }
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [minWidth, maxWidth]);

  return (
    <div className="split-pane" ref={containerRef}>
      <div className="split-pane-left" style={{ width }}>
        {left}
      </div>
      <div className="resize-handle" onMouseDown={handleMouseDown} />
      <div className="split-pane-right">
        {right}
      </div>
    </div>
  );
}
