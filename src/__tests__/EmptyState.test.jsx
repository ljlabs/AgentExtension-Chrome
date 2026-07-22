import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import EmptyState from "../components/EmptyState";

describe("EmptyState", () => {
  it("renders message with label", () => {
    const { container } = render(<EmptyState label="Memories" />);
    const text = container.querySelector(".empty-state-text");
    expect(text.textContent).toMatch(/select a memory from the list to edit/i);
  });

  it("renders generic message without label", () => {
    const { container } = render(<EmptyState label="" />);
    const text = container.querySelector(".empty-state-text");
    expect(text.textContent).toMatch(/select an item from the list to edit/i);
  });
});
