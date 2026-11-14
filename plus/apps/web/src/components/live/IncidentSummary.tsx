import { useQuery } from "@tanstack/react-query";

import { fetchIncidents, type IncidentMode } from "../../api/incidents.js";
import { Card } from "../ui/Card.js";

export function IncidentSummary({
  activityId,
  mode,
}: {
  readonly activityId: string;
  readonly mode: "test" | "rehearsal" | "formal" | undefined;
}) {
  const currentMode = (mode ?? "formal") as IncidentMode;
  const query = useQuery({
    queryKey: ["incidents", activityId, currentMode],
    queryFn: () => fetchIncidents(activityId, currentMode),
    retry: false,
  });
  const unresolved = (query.data ?? []).filter((incident) => incident.status !== "resolved");
  if (query.data === undefined || unresolved.length === 0) return null;

  return (
    <Card className="live-incident-card" data-testid="live-incident-summary">
      <h2 className="ui-card__title">现场事故</h2>
      <p className="ui-field__error" role="status">
        {unresolved.length} 项未解决
      </p>
      <ul className="seat-list">
        {unresolved.slice(0, 3).map((incident) => (
          <li key={incident.id}>{incident.title}</li>
        ))}
      </ul>
    </Card>
  );
}
