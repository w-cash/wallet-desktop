import React from "react";
import { render, screen } from "@testing-library/react";
import App from "./App";

beforeEach(() => {
  Object.defineProperty(window, "wcash", {
    configurable: true,
    value: {
      config: {
        productName: "Wcash Warden Testnet",
        network: "Wcash Testnet",
        ticker: "TWC",
        runtimeReady: false,
        coreRevision: null,
      },
      status: jest.fn(),
    },
  });
});

afterEach(() => {
  delete (window as Partial<Window>).wcash;
});

test("renders the fail-closed Wcash shell", async () => {
  render(<App />);
  expect(screen.getByLabelText("Wcash Warden")).toBeInTheDocument();
  expect(
    await screen.findByRole("heading", { name: "Wcash wallet core did not pass startup checks." }),
  ).toBeInTheDocument();
  expect(window.wcash.status).not.toHaveBeenCalled();
  expect(screen.queryByText(/swap/i)).not.toBeInTheDocument();
});
