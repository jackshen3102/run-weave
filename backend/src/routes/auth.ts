import { Router } from "express";
import { z } from "zod";
import type {
  ChangePasswordRequest,
  LoginRequest,
  LoginResponse,
} from "@browser-viewer/shared";
import type { AuthService } from "../auth/service";
import { readBearerToken } from "../auth/middleware";

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

const changePasswordSchema = z.object({
  oldPassword: z.string().min(1),
  newPassword: z.string().min(1),
});

export function createAuthRouter(authService: AuthService): Router {
  const router = Router();

  router.post("/login", (req, res) => {
    const parsed = loginSchema.safeParse(req.body as LoginRequest);
    if (!parsed.success) {
      res.status(400).json({
        message: "Invalid request body",
        errors: parsed.error.flatten(),
      });
      return;
    }

    const result = authService.login(
      parsed.data.username,
      parsed.data.password,
    );
    if (!result) {
      res.status(401).json({ message: "Invalid credentials" });
      return;
    }

    const payload: LoginResponse = {
      token: result.token,
      expiresIn: result.expiresIn,
    };
    res.status(200).json(payload);
  });

  router.get("/verify", (req, res) => {
    const token = readBearerToken(req);
    if (!token || !authService.verifyToken(token)) {
      res.status(401).json({ message: "Unauthorized" });
      return;
    }

    res.status(200).json({ valid: true });
  });

  router.post("/password", async (req, res) => {
    const token = readBearerToken(req);
    if (!token || !authService.verifyToken(token)) {
      res.status(401).json({ message: "Unauthorized" });
      return;
    }

    const parsed = changePasswordSchema.safeParse(
      req.body as ChangePasswordRequest,
    );
    if (!parsed.success) {
      res.status(400).json({
        message: "Invalid request body",
        errors: parsed.error.flatten(),
      });
      return;
    }

    const changed = await authService.changePassword(
      parsed.data.oldPassword,
      parsed.data.newPassword,
    );
    if (!changed) {
      res.status(403).json({ message: "Invalid credentials" });
      return;
    }

    res.status(204).send();
  });

  return router;
}
