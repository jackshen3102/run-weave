import { ResourceSettings } from "../../system-monitor/resource-settings";
import { useResources } from "../../system-monitor/resource-monitor-provider";
export default function Monitoring() {
  const resource = useResources();
  return <ResourceSettings embedded onSaved={resource.refresh} />;
}
