import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import Sidebar from "../components/Sidebar";

const mockItems = [
  { id: "mem_1", title: "First Memory", updated: "2024-01-15T10:00:00Z" },
  { id: "mem_2", title: "Second Memory", updated: "2024-01-16T12:00:00Z" }
];

describe("Sidebar", () => {
  it("renders item titles", () => {
    render(
      <Sidebar
        items={mockItems}
        selectedId={null}
        onSelect={vi.fn()}
        onNew={vi.fn()}
        label="Memories"
      />
    );

    expect(screen.getByText("First Memory")).toBeInTheDocument();
    expect(screen.getByText("Second Memory")).toBeInTheDocument();
  });

  it("shows empty state when no items", () => {
    render(
      <Sidebar
        items={[]}
        selectedId={null}
        onSelect={vi.fn()}
        onNew={vi.fn()}
        label="Memories"
      />
    );

    expect(screen.getByText(/no memories yet/i)).toBeInTheDocument();
  });

  it("calls onSelect when item clicked", () => {
    const onSelect = vi.fn();
    render(
      <Sidebar
        items={mockItems}
        selectedId={null}
        onSelect={onSelect}
        onNew={vi.fn()}
        label="Memories"
      />
    );

    fireEvent.click(screen.getByText("First Memory"));
    expect(onSelect).toHaveBeenCalledWith("mem_1");
  });

  it("highlights selected item", () => {
    render(
      <Sidebar
        items={mockItems}
        selectedId="mem_1"
        onSelect={vi.fn()}
        onNew={vi.fn()}
        label="Memories"
      />
    );

    const items = document.querySelectorAll(".sidebar-item");
    expect(items[0]).toHaveClass("active");
    expect(items[1]).not.toHaveClass("active");
  });

  it("calls onNew when new button clicked", () => {
    const onNew = vi.fn();
    render(
      <Sidebar
        items={mockItems}
        selectedId={null}
        onSelect={vi.fn()}
        onNew={onNew}
        label="Memories"
      />
    );

    fireEvent.click(screen.getByText("+ New"));
    expect(onNew).toHaveBeenCalled();
  });
});
