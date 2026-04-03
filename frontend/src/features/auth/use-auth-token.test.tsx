import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useAuthToken } from "./use-auth-token";

describe("useAuthToken", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("loads, updates, and clears the web auth token", async () => {
    localStorage.setItem("viewer.auth.token", "token-1");

    const { result } = renderHook(() => useAuthToken("viewer.auth.token"));

    expect(result.current.token).toBe("token-1");

    result.current.setToken("token-2");
    await waitFor(() => {
      expect(result.current.token).toBe("token-2");
    });
    expect(localStorage.getItem("viewer.auth.token")).toBe("token-2");

    result.current.clearToken();
    await waitFor(() => {
      expect(result.current.token).toBeNull();
    });
    expect(localStorage.getItem("viewer.auth.token")).toBeNull();
  });
});
