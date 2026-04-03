import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChangePasswordDialog } from "./change-password-dialog";

describe("ChangePasswordDialog", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not render when closed", () => {
    render(
      <ChangePasswordDialog
        open={false}
        loading={false}
        error={null}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );

    expect(screen.queryByText("Change Password")).toBeNull();
  });

  it("submits the entered passwords from the action button", async () => {
    const onSubmit = vi.fn(async () => undefined);

    render(
      <ChangePasswordDialog
        open
        loading={false}
        error={null}
        onClose={vi.fn()}
        onSubmit={onSubmit}
      />,
    );

    fireEvent.change(screen.getByLabelText("Current Password"), {
      target: { value: "old-secret" },
    });
    fireEvent.change(screen.getByLabelText("New Password"), {
      target: { value: "new-secret" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Update Password" }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({
        oldPassword: "old-secret",
        newPassword: "new-secret",
      });
    });
  });

  it("shows loading and error states and supports enter-to-submit", async () => {
    const onSubmit = vi.fn(async () => undefined);
    const onClose = vi.fn();

    const { rerender } = render(
      <ChangePasswordDialog
        open
        loading={false}
        error={"Incorrect current password."}
        onClose={onClose}
        onSubmit={onSubmit}
      />,
    );

    fireEvent.change(screen.getByLabelText("Current Password"), {
      target: { value: "old-secret" },
    });
    fireEvent.keyDown(screen.getByLabelText("New Password"), {
      key: "Enter",
      code: "Enter",
      charCode: 13,
    });

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({
        oldPassword: "old-secret",
        newPassword: "",
      });
    });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Incorrect current password.",
    );

    rerender(
      <ChangePasswordDialog
        open
        loading
        error={null}
        onClose={onClose}
        onSubmit={onSubmit}
      />,
    );

    expect(screen.getByRole("button", { name: "Updating..." })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Close" })).toBeDisabled();
  });
});
