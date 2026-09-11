import React from "react";
import { render, screen } from "@testing-library/react";
import App from "./App";

test("renders without crashing", () => {
  render(<App />);
});

test("displays the Wcash safety shell", () => {
  render(<App />);
  expect(screen.getByRole("heading", { name: "Wcash Warden" })).toBeInTheDocument();
  expect(screen.getByText("Wallet runtime not installed")).toBeInTheDocument();
});
