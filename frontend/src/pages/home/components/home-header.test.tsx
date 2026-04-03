import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { HomeHeader } from "./home-header";

describe("HomeHeader", () => {
  it("renders a change password entry and calls the handler", () => {
    const onOpenChangePassword = vi.fn();

    render(
      <HomeHeader
        terminalLoading={false}
        onOpenTerminal={vi.fn()}
        onOpenChangePassword={onOpenChangePassword}
        onLogout={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Change Password" }));

    expect(onOpenChangePassword).toHaveBeenCalledTimes(1);
  });
});
