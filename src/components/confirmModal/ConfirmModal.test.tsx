import React from "react";
import { render, screen, fireEvent, waitFor } from "../../test-utils";
import ConfirmModal from "./ConfirmModal";
import { ConfirmModalClass } from "../appstate";

jest.mock("../../electronBridge");

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { native } = require("../../electronBridge");

beforeAll(() => {
  const div = document.createElement("div");
  div.setAttribute("id", "root");
  document.body.appendChild(div);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("react-modal").setAppElement("#root");
});

const makeOpenModal = (runAction: () => void = jest.fn()): ConfirmModalClass => {
  const m = new ConfirmModalClass();
  m.title = "Delete wallet?";
  m.body = "This action cannot be undone.";
  m.modalIsOpen = true;
  m.runAction = runAction;
  return m;
};

describe("ConfirmModal", () => {
  beforeEach(() => {
    (native.cancel_transaction_proposal as jest.Mock).mockReset().mockResolvedValue('{"cancelled":true}');
  });

  it("renders the title when open", () => {
    render(<ConfirmModal closeModal={jest.fn()} />, {
      contextOverrides: { confirmModal: makeOpenModal() },
    });
    expect(screen.getByText("Delete wallet?")).toBeInTheDocument();
  });

  it("renders the body when open", () => {
    render(<ConfirmModal closeModal={jest.fn()} />, {
      contextOverrides: { confirmModal: makeOpenModal() },
    });
    expect(screen.getByText("This action cannot be undone.")).toBeInTheDocument();
  });

  it("releases a staged proposal and closes when Cancel is clicked", () => {
    const closeModal = jest.fn();
    render(<ConfirmModal closeModal={closeModal} />, {
      contextOverrides: { confirmModal: makeOpenModal() },
    });
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    expect(native.cancel_transaction_proposal).toHaveBeenCalledTimes(1);
    expect(closeModal).toHaveBeenCalledTimes(1);
  });

  it("handles a rejected staged-proposal cancellation", async () => {
    const error = new Error("proposal retained");
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
    (native.cancel_transaction_proposal as jest.Mock).mockRejectedValue(error);
    const closeModal = jest.fn();
    render(<ConfirmModal closeModal={closeModal} />, {
      contextOverrides: { confirmModal: makeOpenModal() },
    });
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    expect(closeModal).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(consoleError).toHaveBeenCalledWith("cancel_transaction_proposal", error));
    consoleError.mockRestore();
  });

  it("calls runAction and closeModal when Confirm is clicked", () => {
    const runAction = jest.fn();
    const closeModal = jest.fn();
    render(<ConfirmModal closeModal={closeModal} />, {
      contextOverrides: { confirmModal: makeOpenModal(runAction) },
    });
    fireEvent.click(screen.getByRole("button", { name: /confirm/i }));
    expect(runAction).toHaveBeenCalledTimes(1);
    expect(closeModal).toHaveBeenCalledTimes(1);
    expect(native.cancel_transaction_proposal).not.toHaveBeenCalled();
  });

  it("does not render content when closed", () => {
    const closed = new ConfirmModalClass();
    closed.modalIsOpen = false;
    render(<ConfirmModal closeModal={jest.fn()} />, {
      contextOverrides: { confirmModal: closed },
    });
    expect(screen.queryByText("Delete wallet?")).not.toBeInTheDocument();
  });
});
