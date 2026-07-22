import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import SplitPane from "../components/SplitPane";

describe("SplitPane", () => {
  it("renders left and right children", () => {
    render(
      <SplitPane
        left={<div data-testid="left">Left Panel</div>}
        right={<div data-testid="right">Right Panel</div>}
      />
    );

    expect(screen.getByTestId("left")).toBeInTheDocument();
    expect(screen.getByTestId("right")).toBeInTheDocument();
  });

  it("renders resize handle", () => {
    render(
      <SplitPane
        left={<div>Left</div>}
        right={<div>Right</div>}
      />
    );

    expect(document.querySelector(".resize-handle")).toBeInTheDocument();
  });

  it("applies default width to left pane", () => {
    render(
      <SplitPane
        left={<div>Left</div>}
        right={<div>Right</div>}
        defaultWidth={300}
      />
    );

    const leftPane = document.querySelector(".split-pane-left");
    expect(leftPane).toHaveStyle({ width: "300px" });
  });
});
