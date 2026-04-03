import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LoginPage } from "./login-page";

vi.mock("../services/auth", () => ({
  login: vi.fn(async () => ({ token: "token-1" })),
}));

const REMEMBERED_CREDENTIALS_STORAGE_KEY = "viewer.auth.remembered-credentials";
const CONNECTION_AUTH_STORAGE_KEY = "viewer.auth.connection-auth";

describe("LoginPage", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  beforeEach(() => {
    localStorage.clear();
  });

  it("ignores and clears legacy remembered credentials", () => {
    localStorage.setItem(
      REMEMBERED_CREDENTIALS_STORAGE_KEY,
      JSON.stringify({
        username: "saved-admin",
        password: "saved-secret",
      }),
    );

    render(<LoginPage apiBase="" onSuccess={vi.fn()} />);

    expect(screen.getByLabelText("Username")).toHaveValue("admin");
    expect(screen.getByLabelText("Password")).toHaveValue("");
    expect(screen.queryByLabelText("Remember password")).toBeNull();
    expect(localStorage.getItem(REMEMBERED_CREDENTIALS_STORAGE_KEY)).toBeNull();
  });

  it("does not persist plaintext credentials after login", async () => {
    const onSuccess = vi.fn();

    render(<LoginPage apiBase="" onSuccess={onSuccess} />);

    fireEvent.change(screen.getByLabelText("Username"), {
      target: { value: "admin-user" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "super-secret" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => {
      expect(onSuccess).toHaveBeenCalledWith("token-1");
    });

    expect(localStorage.getItem(REMEMBERED_CREDENTIALS_STORAGE_KEY)).toBeNull();
  });

  it("sanitizes legacy scoped credentials but preserves the token", () => {
    localStorage.setItem(
      CONNECTION_AUTH_STORAGE_KEY,
      JSON.stringify({
        "conn-2": {
          token: "token-2",
          username: "saved-admin",
          password: "saved-secret",
        },
      }),
    );

    render(
      <LoginPage
        apiBase=""
        connectionId="conn-2"
        isElectron
        onSuccess={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("Username")).toHaveValue("admin");
    expect(screen.getByLabelText("Password")).toHaveValue("");
    expect(screen.queryByLabelText("Remember password")).toBeNull();
    expect(
      JSON.parse(localStorage.getItem(CONNECTION_AUTH_STORAGE_KEY) ?? "{}"),
    ).toEqual({
      "conn-2": {
        token: "token-2",
      },
    });
  });

  it("renders the connection switcher trigger in electron mode", () => {
    render(
      <LoginPage
        apiBase=""
        connectionId="conn-2"
        isElectron
        connectionName="Coze 助手"
        onSwitchConnection={vi.fn()}
        onOpenConnectionManager={vi.fn()}
        onSuccess={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("button", { name: /当前连接.*coze 助手/i }),
    ).toBeInTheDocument();
  });
});
