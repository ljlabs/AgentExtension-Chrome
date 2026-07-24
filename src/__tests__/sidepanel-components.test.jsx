import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import ChatLog from "../sidepanel/components/ChatLog.jsx";
import PermissionModal from "../sidepanel/components/PermissionModal.jsx";
import StatusBar from "../sidepanel/components/StatusBar.jsx";
import Composer from "../sidepanel/components/Composer.jsx";
import QuestionCard from "../sidepanel/components/QuestionCard.jsx";
import ApprovalCard from "../sidepanel/components/ApprovalCard.jsx";
import PlanCard from "../sidepanel/components/PlanCard.jsx";
import * as controller from "../sidepanel/agent/controller.js";

describe("ChatLog", () => {
  it("renders each message kind", () => {
    const items = [
      { id: "1", kind: "user", text: "hello agent" },
      { id: "2", kind: "assistant", text: "hi there", chips: [{ name: "get_text", ok: true }] },
      { id: "3", kind: "system", text: "Ready." },
      { id: "4", kind: "error", text: "boom" },
      { id: "5", kind: "tool-result", ok: true, toolName: "get_html", argsText: '{"maxLength":100}', resultText: '{"ok":true}' }
    ];

    render(<ChatLog items={items} />);

    expect(screen.getByText("hello agent")).toBeInTheDocument();
    expect(screen.getByText("hi there")).toBeInTheDocument();
    expect(screen.getByText("get_text")).toBeInTheDocument();
    expect(screen.getByText("Ready.")).toBeInTheDocument();
    expect(screen.getByText("boom")).toBeInTheDocument();
    expect(screen.getByText("get_html")).toBeInTheDocument();
  });

  it("tool bubble collapses result by default and expands on click", () => {
    render(<ChatLog items={[
      { id: "t1", kind: "tool-result", ok: true, toolName: "get_text", argsText: "{}", resultText: '{"ok":true,"data":"page text"}' }
    ]} />);

    // Collapsed: result hidden, header visible.
    expect(screen.queryByText(/page text/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { expanded: false }));
    expect(screen.getByText(/page text/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { expanded: true }));
    expect(screen.queryByText(/page text/)).not.toBeInTheDocument();
  });

  it("failed tool bubble renders with error styling and ✗ marker", () => {
    render(<ChatLog items={[
      { id: "t2", kind: "tool-result", ok: false, toolName: "click", argsText: '{"ref":"e9"}', resultText: '{"ok":false,"error":"Ref not found"}' }
    ]} />);

    expect(screen.getByText("✗")).toBeInTheDocument();
    expect(screen.getByText("click")).toBeInTheDocument();
  });

  it("marks invalid tool chips", () => {
    render(<ChatLog items={[
      { id: "1", kind: "assistant", text: "", chips: [{ name: "bad_tool", ok: false }] }
    ]} />);

    expect(screen.getByText("bad_tool invalid")).toBeInTheDocument();
    expect(screen.getByText("Calling tools...")).toBeInTheDocument();
  });
});

describe("PermissionModal", () => {
  it("renders nothing without an active permission", () => {
    const { container } = render(<PermissionModal permission={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("resolves through closePermission on Allow once", () => {
    const resolve = vi.fn();
    render(<PermissionModal permission={{ kind: "image", message: "Take a screenshot?", meta: {}, resolve }} />);

    expect(screen.getByText("Image permission")).toBeInTheDocument();

    // closePermission reads state.activePermission — set it up to match.
    controller.state?.activePermission;
    fireEvent.click(screen.getByText("Allow once"));
  });

  it("shows network title for network permissions", () => {
    render(<PermissionModal permission={{ kind: "network", message: "Call https://x.test?", meta: {}, resolve: vi.fn() }} />);
    expect(screen.getByText("Network permission")).toBeInTheDocument();
  });
});

describe("StatusBar", () => {
  it("hides when empty and shows text when set", () => {
    const { container, rerender } = render(<StatusBar text="" />);
    expect(container).toBeEmptyDOMElement();

    rerender(<StatusBar text="Step 1: calling model..." />);
    expect(screen.getByText("Step 1: calling model...")).toBeInTheDocument();
  });
});

describe("Composer", () => {
  it("disables input while running and shows Stop", () => {
    render(<Composer isRunning={true} />);
    expect(screen.getByPlaceholderText(/Ask about this page/)).toBeDisabled();
    expect(screen.getByText("Stop")).toBeInTheDocument();
  });

  it("hides Stop when idle", () => {
    render(<Composer isRunning={false} />);
    expect(screen.queryByText("Stop")).not.toBeInTheDocument();
    expect(screen.getByText("Send")).toBeEnabled();
  });
});

describe("QuestionCard", () => {
  it("renders pending options and resolves on submit", () => {
    const spy = vi.spyOn(controller, "resolveInteraction").mockImplementation(() => {});

    render(<QuestionCard item={{
      id: "q1",
      pending: true,
      args: { question: "Which env?", options: ["dev", "prod"], allowFreeText: true }
    }} />);

    expect(screen.getByText("Which env?")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("dev"));
    fireEvent.click(screen.getByText("Submit Answer"));

    expect(spy).toHaveBeenCalledWith("q1", expect.objectContaining({ answer: "dev", selectedOptions: ["dev"] }));
    spy.mockRestore();
  });

  it("renders completed state from response", () => {
    render(<QuestionCard item={{
      id: "q2",
      pending: false,
      args: { question: "Which env?" },
      response: { answer: "dev" }
    }} />);

    expect(screen.getByText("Answered: dev")).toBeInTheDocument();
    expect(screen.queryByText("Submit Answer")).not.toBeInTheDocument();
  });
});

describe("ApprovalCard", () => {
  it("resolves approved on Approve", () => {
    const spy = vi.spyOn(controller, "resolveInteraction").mockImplementation(() => {});

    render(<ApprovalCard item={{
      id: "a1",
      pending: true,
      args: { actionType: "SUBMIT", description: "Submit the form" }
    }} />);

    fireEvent.click(screen.getByText("Approve"));
    expect(spy).toHaveBeenCalledWith("a1", { approved: true, decision: "approved" });
    spy.mockRestore();
  });

  it("renders completed rejected state", () => {
    render(<ApprovalCard item={{
      id: "a2",
      pending: false,
      args: { actionType: "SUBMIT", description: "Submit the form" },
      response: { approved: false }
    }} />);

    expect(screen.getByText("Rejected")).toBeInTheDocument();
  });
});

describe("PlanCard", () => {
  it("shows steps and resolves with feedback", () => {
    const spy = vi.spyOn(controller, "resolveInteraction").mockImplementation(() => {});

    render(<PlanCard item={{
      id: "p1",
      pending: true,
      args: { title: "Deploy plan", steps: ["Open page", "Click deploy"], notes: "risky" }
    }} />);

    expect(screen.getByText("Deploy plan")).toBeInTheDocument();
    expect(screen.getByText("Open page")).toBeInTheDocument();
    expect(screen.getByText("risky")).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("Feedback or modifications..."), { target: { value: "go slow" } });
    fireEvent.click(screen.getByText("Approve Plan"));

    expect(spy).toHaveBeenCalledWith("p1", { approved: true, feedback: "go slow" });
    spy.mockRestore();
  });

  it("resolves the auto-approve option with the opt-in flag", () => {
    const spy = vi.spyOn(controller, "resolveInteraction").mockImplementation(() => {});

    render(<PlanCard item={{
      id: "p-auto",
      pending: true,
      args: { title: "Search plan", steps: ["Type query", "Submit search"] }
    }} />);

    fireEvent.click(screen.getByText("Approve & Auto-approve Actions"));
    expect(spy).toHaveBeenCalledWith("p-auto", {
      approved: true,
      feedback: "",
      autoApprove: true
    });
    spy.mockRestore();
  });

  it("renders completed approved state with feedback", () => {
    render(<PlanCard item={{
      id: "p2",
      pending: false,
      args: { title: "Deploy plan", steps: ["a"] },
      response: { approved: true, feedback: "ok" }
    }} />);

    expect(screen.getByText('Plan Approved with feedback: "ok"')).toBeInTheDocument();
  });
});
