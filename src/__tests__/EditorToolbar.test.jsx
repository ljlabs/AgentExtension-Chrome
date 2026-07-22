import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import EditorToolbar from "../components/EditorToolbar";

describe("EditorToolbar", () => {
  it("renders item title", () => {
    render(
      <EditorToolbar
        title="My Rule"
        dirty={false}
        onSave={vi.fn()}
        onDelete={vi.fn()}
      />
    );

    expect(screen.getByText("My Rule")).toBeInTheDocument();
  });

  it("shows modified indicator when dirty", () => {
    render(
      <EditorToolbar
        title="My Rule"
        dirty={true}
        onSave={vi.fn()}
        onDelete={vi.fn()}
      />
    );

    expect(screen.getByText("(modified)")).toBeInTheDocument();
  });

  it("calls onSave when save button clicked", () => {
    const onSave = vi.fn();
    render(
      <EditorToolbar
        title="My Rule"
        dirty={true}
        onSave={onSave}
        onDelete={vi.fn()}
      />
    );

    fireEvent.click(screen.getByText("Save"));
    expect(onSave).toHaveBeenCalled();
  });

  it("calls onDelete when delete button clicked", () => {
    const onDelete = vi.fn();
    render(
      <EditorToolbar
        title="My Rule"
        dirty={false}
        onSave={vi.fn()}
        onDelete={onDelete}
      />
    );

    fireEvent.click(screen.getByText("Delete"));
    expect(onDelete).toHaveBeenCalled();
  });

  it("disables save button when not dirty", () => {
    render(
      <EditorToolbar
        title="My Rule"
        dirty={false}
        onSave={vi.fn()}
        onDelete={vi.fn()}
      />
    );

    expect(screen.getByText("Save")).toBeDisabled();
  });
});
