export interface AppAuthSession {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  expiresAt: number;
  sessionId: string;
}
