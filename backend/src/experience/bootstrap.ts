import type { ActivityStore } from "../activity/recording/store";
import { logger } from "../logging/index";
import { ExperienceService } from "./service";
import { ExperienceLearningRuntime } from "./learning-runtime";
import { resolveExperienceStorage } from "./storage";

export function createExperienceLearning(
  activity: ActivityStore | null,
  channel: "stable" | "beta" | "dev",
) {
  const storage = resolveExperienceStorage(process.env);
  const experienceService = new ExperienceService(storage);
  const enabled =
    process.env.RUNWEAVE_EXPERIENCE_LEARNING === "true" ||
    (channel === "stable" &&
      process.env.RUNWEAVE_EXPERIENCE_LEARNING !== "false");
  const experienceLearning = new ExperienceLearningRuntime(
    storage,
    experienceService,
    activity,
    enabled,
    channel,
    (error) => logger.warn("experience.learning.failed", { error }),
  );
  return { experienceService, experienceLearning };
}
