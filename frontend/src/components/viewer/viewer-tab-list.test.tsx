import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ViewerTabList } from "./viewer-tab-list";

describe("ViewerTabList", () => {
  it("renders an empty state when no tabs exist", () => {
    render(<ViewerTabList tabs={[]} onSwitchTab={vi.fn()} />);

    expect(screen.getByText("Waiting for tabs...")).toBeInTheDocument();
  });

  it("switches only when clicking an inactive tab", () => {
    const onSwitchTab = vi.fn();

    render(
      <ViewerTabList
        tabs={[
          {
            id: "tab-1",
            title: "Active Tab",
            url: "https://active.example",
            active: true,
          },
          {
            id: "tab-2",
            title: "",
            url: "https://inactive.example",
            active: false,
          },
        ]}
        onSwitchTab={onSwitchTab}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Active Tab" }));
    fireEvent.click(screen.getByRole("button", { name: "https://inactive.example" }));

    expect(onSwitchTab).toHaveBeenCalledTimes(1);
    expect(onSwitchTab).toHaveBeenCalledWith("tab-2");
  });
});
