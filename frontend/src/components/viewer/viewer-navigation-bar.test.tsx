import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ViewerNavigationBar } from "./viewer-navigation-bar";

describe("ViewerNavigationBar", () => {
  afterEach(() => {
    cleanup();
  });

  it("dispatches navigation and address callbacks", () => {
    const onAddressFocus = vi.fn();
    const onAddressChange = vi.fn();
    const onAddressBlur = vi.fn();
    const onAddressSubmit = vi.fn();
    const onAddressCancel = vi.fn();
    const onNavigationAction = vi.fn();

    render(
      <ViewerNavigationBar
        activeTabId="tab-1"
        activeNavigation={{
          tabId: "tab-1",
          url: "https://example.com",
          isLoading: false,
          canGoBack: true,
          canGoForward: true,
        }}
        addressInput="https://example.com"
        onAddressFocus={onAddressFocus}
        onAddressChange={onAddressChange}
        onAddressBlur={onAddressBlur}
        onAddressSubmit={onAddressSubmit}
        onAddressCancel={onAddressCancel}
        onNavigationAction={onNavigationAction}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.click(screen.getByRole("button", { name: "Forward" }));
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    const input = screen.getByTestId("address-input");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "https://openai.com" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Escape" });
    fireEvent.blur(input);

    expect(onNavigationAction).toHaveBeenNthCalledWith(1, "back");
    expect(onNavigationAction).toHaveBeenNthCalledWith(2, "forward");
    expect(onNavigationAction).toHaveBeenNthCalledWith(3, "reload");
    expect(onAddressFocus).toHaveBeenCalledTimes(1);
    expect(onAddressChange).toHaveBeenCalledWith("https://openai.com");
    expect(onAddressSubmit).toHaveBeenCalledTimes(1);
    expect(onAddressCancel).toHaveBeenCalledTimes(1);
    expect(onAddressBlur).toHaveBeenCalledTimes(1);
  });

  it("uses stop while loading and blocks disabled navigation", () => {
    const onNavigationAction = vi.fn();

    render(
      <ViewerNavigationBar
        activeTabId={null}
        activeNavigation={{
          tabId: "tab-1",
          url: "https://example.com",
          isLoading: true,
          canGoBack: false,
          canGoForward: false,
        }}
        addressInput="https://example.com"
        onAddressFocus={vi.fn()}
        onAddressChange={vi.fn()}
        onAddressBlur={vi.fn()}
        onAddressSubmit={vi.fn()}
        onAddressCancel={vi.fn()}
        onNavigationAction={onNavigationAction}
      />,
    );

    expect(screen.getByRole("button", { name: "Back" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Forward" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(onNavigationAction).not.toHaveBeenCalled();
  });
});
