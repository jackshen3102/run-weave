export interface LoginRequest {
  username: string;
  password: string;
}

export type AuthClientType = "web" | "electron" | "app";

export interface LoginResponse {
  accessToken: string;
  refreshToken?: string;
  expiresIn: number;
  sessionId: string;
}

export interface RefreshSessionRequest {
  refreshToken: string;
}

export interface RefreshSessionResponse {
  accessToken: string;
  refreshToken?: string;
  expiresIn: number;
  sessionId: string;
}

export interface ChangePasswordRequest {
  oldPassword: string;
  newPassword: string;
}
