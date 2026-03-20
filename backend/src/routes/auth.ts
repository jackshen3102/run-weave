import { Router } from "express";
import { z } from "zod";
import type { LoginRequest, LoginResponse } from "@browser-viewer/shared";
import type { AuthService } from "../auth/service";

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
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

  return router;
}
