import { configuration, setting } from "@runweave/config-node";
import { readConfigurationPath } from "@runweave/shared/configuration";

export function registerSupervisionConfiguration(cancel: () => void) {
  return configuration().register("backend.taskSupervision", (snapshot) => {
    if (
      JSON.stringify(
        readConfigurationPath(snapshot.value, "backend.taskSupervision"),
      ) !== JSON.stringify(setting("backend.taskSupervision"))
    )
      cancel();
  });
}
