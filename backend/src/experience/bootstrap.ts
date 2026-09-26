import { configuration, settingText } from "@runweave/config-node";
import type { ActivityStore } from "../activity/recording/store";
import { logger } from "../logging/index";
import { ExperienceService } from "./service";
import { ExperienceLearningRuntime } from "./learning-runtime";
import { resolveExperienceStorage } from "./storage";

export function createExperienceLearning(
  activity: ActivityStore | null,
  channel: "stable" | "beta" | "dev",
) {
  const storage = resolveExperienceStorage();
  const experienceService = new ExperienceService(storage);
  let valid = true;
  try { configuration().requireDomain("knowledge"); } catch { valid = false; }
  const enabled = valid && (
    settingText("knowledge.experience.learning") === "true" ||
    (channel === "stable" &&
      settingText("knowledge.experience.learning") !== "false"));
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
