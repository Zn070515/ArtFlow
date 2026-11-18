import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("qrcode", () => ({
  toDataURL: vi.fn().mockResolvedValue("data:image/png;base64,QR"),
}));

import { EventShare } from "./EventShare.js";

describe("EventShare", () => {
  it("opens a QR code for the canonical event URL", async () => {
    render(<EventShare title="春日声场" publicCode="SPRING-1" />);
    fireEvent.click(screen.getByRole("button", { name: "二维码" }));
    const image = await screen.findByAltText("春日声场 活动二维码");
    expect(image).toHaveAttribute("src", "data:image/png;base64,QR");
    expect(screen.getByText("http://localhost:3000/e/SPRING-1")).toBeInTheDocument();
  });
});
