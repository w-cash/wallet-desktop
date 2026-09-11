import React from "react";
import { render, screen } from "@testing-library/react";
import Root from "./Root";

describe("Wcash pre-core root", () => {
  it("renders an explicit Testnet-only runtime gate", () => {
    render(<Root />);

    expect(screen.getByRole("heading", { name: "Wcash Warden" })).toBeInTheDocument();
    expect(screen.getByText("Wallet runtime not installed")).toBeInTheDocument();
    expect(screen.getByText("Wcash Testnet only")).toBeInTheDocument();
    expect(screen.getByText("Awaiting reviewed wallet-core commit")).toBeInTheDocument();
  });

  it("keeps every planned wallet action disabled", () => {
    render(<Root />);

    expect(screen.getAllByRole("button")).toHaveLength(3);
    screen.getAllByRole("button").forEach((button) => expect(button).toBeDisabled());
  });

  it("does not present legacy online features", () => {
    render(<Root />);

    expect(screen.queryByText(/swap/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/donat/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/price/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/zns/i)).not.toBeInTheDocument();
  });
});
