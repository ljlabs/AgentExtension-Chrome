import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import Markdown from "../sidepanel/components/Markdown.jsx";

describe("Markdown component", () => {
  it("renders headings, bold, italic, and inline code", () => {
    const { container } = render(
      <Markdown text={"# Title\n\nSome **bold** and *italic* and `code`."} />
    );

    expect(container.querySelector("h1")).toHaveTextContent("Title");
    expect(container.querySelector("strong")).toHaveTextContent("bold");
    expect(container.querySelector("em")).toHaveTextContent("italic");
    expect(container.querySelector("code")).toHaveTextContent("code");
  });

  it("renders fenced code blocks verbatim", () => {
    const { container } = render(
      <Markdown text={"```\nconst x = 1;\n```"} />
    );

    expect(container.querySelector("pre code")).toHaveTextContent("const x = 1;");
  });

  it("renders lists", () => {
    const { container } = render(
      <Markdown text={"- one\n- two\n\n1. first\n2. second"} />
    );

    expect(container.querySelectorAll("ul li")).toHaveLength(2);
    expect(container.querySelectorAll("ol li")).toHaveLength(2);
  });

  it("renders links with safe attributes", () => {
    const { container } = render(<Markdown text={"[site](https://x.test)"} />);
    const a = container.querySelector("a");
    expect(a).toHaveAttribute("href", "https://x.test");
    expect(a).toHaveAttribute("target", "_blank");
    expect(a).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("does not inject HTML from text (renders as literal text)", () => {
    const { container } = render(<Markdown text={'<img src=x onerror="alert(1)">'} />);
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText(/<img src=x/)).toBeInTheDocument();
  });

  it("renders blockquotes and horizontal rules", () => {
    const { container } = render(<Markdown text={"> quoted\n\n---"} />);
    expect(container.querySelector("blockquote")).toHaveTextContent("quoted");
    expect(container.querySelector("hr")).toBeInTheDocument();
  });

  it("returns null for empty input", () => {
    const { container } = render(<Markdown text="" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders identically on re-mount (restored transcript scenario)", () => {
    const text = "## Restored\n\n**bold** survives remount";
    const first = render(<Markdown text={text} />);
    const firstHtml = first.container.innerHTML;
    first.unmount();

    const second = render(<Markdown text={text} />);
    expect(second.container.innerHTML).toBe(firstHtml);
    expect(second.container.querySelector("h2")).toHaveTextContent("Restored");
    expect(second.container.querySelector("strong")).toHaveTextContent("bold");
  });
});
