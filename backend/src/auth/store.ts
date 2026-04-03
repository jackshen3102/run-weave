export interface PersistedAuthRecord {
  username: string;
  password: string;
  jwtSecret: string;
  updatedAt: string;
}

export interface AuthStore {
  initialize(defaultRecord: PersistedAuthRecord): Promise<PersistedAuthRecord>;
  updatePassword(params: {
    password: string;
    jwtSecret: string;
    updatedAt: string;
  }): Promise<PersistedAuthRecord>;
  dispose(): Promise<void>;
}
