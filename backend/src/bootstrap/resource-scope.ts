import { logger } from "../logging/index";

type Cleanup = () => void | Promise<void>;

/** Owns acquired resources, not borrowed service dependencies. */
export class ResourceScope {
  private readonly resources: Array<{ name: string; cleanup: Cleanup }> = [];
  private disposal: Promise<void> | null = null;

  defer(name: string, cleanup: Cleanup): void {
    if (this.disposal)
      throw new Error(`Resource scope already disposing: ${name}`);
    this.resources.push({ name, cleanup });
  }

  dispose(): Promise<void> {
    this.disposal ??= this.release();
    return this.disposal;
  }

  private async release(): Promise<void> {
    const errors: Error[] = [];
    for (const { name, cleanup } of this.resources.splice(0).reverse()) {
      try {
        await cleanup();
      } catch (cause) {
        logger.error("backend.resource.cleanup.failed", {
          resource: name,
          error: cause,
        });
        errors.push(new Error(`Resource cleanup failed: ${name}`, { cause }));
      }
    }
    if (errors.length)
      throw new AggregateError(
        errors,
        `Runtime cleanup failed: ${errors.map((error) => error.message).join("; ")}`,
      );
  }
}
