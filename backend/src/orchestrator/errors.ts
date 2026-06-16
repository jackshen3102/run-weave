export class OrchestratorError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "OrchestratorError";
  }
}
