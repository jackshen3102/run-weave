import type Database from "better-sqlite3";
import type {
  ActivityContentDescriptorDto,
  ActivityExternalRefDescriptorDto,
} from "@runweave/shared/activity";

export function readContentDescriptors(
  database: Database.Database,
  eventIds: string[],
): Map<string, ActivityContentDescriptorDto[]> {
  if (!eventIds.length) return new Map();
  const rows = database
    .prepare(
      `SELECT link.event_id, content.content_id, link.role, content.media_type, content.byte_length,
      content.sha256, content.current_availability, link.expected_expires_at_ms
     FROM fact_content_links link
     JOIN activity_contents content ON content.content_id = link.content_id
     WHERE link.event_id IN (SELECT value FROM json_each(?)) ORDER BY link.event_id, link.ordinal`,
    )
    .all(JSON.stringify(eventIds)) as Array<{
    event_id: string;
    content_id: string;
    role: ActivityContentDescriptorDto["role"];
    media_type: string;
    byte_length: number;
    sha256: string;
    current_availability: ActivityContentDescriptorDto["availability"];
    expected_expires_at_ms: number;
  }>;
  return groupDescriptors(
    rows.map((row) => ({
      eventId: row.event_id,
      descriptor: {
        contentId: row.content_id,
        role: row.role,
        mediaType: row.media_type,
        byteLength: row.byte_length,
        sha256: row.sha256,
        availability: row.current_availability,
        expectedExpiresAt: new Date(row.expected_expires_at_ms).toISOString(),
      },
    })),
  );
}

export function readRefDescriptors(
  database: Database.Database,
  eventIds: string[],
): Map<string, ActivityExternalRefDescriptorDto[]> {
  if (!eventIds.length) return new Map();
  const rows = database
    .prepare(
      `SELECT link.event_id, ref.ref_id, link.role, ref.authority, ref.version_or_digest,
      ref.current_availability
     FROM fact_external_ref_links link
     JOIN external_refs ref ON ref.ref_id = link.ref_id
     WHERE link.event_id IN (SELECT value FROM json_each(?)) ORDER BY link.event_id, link.ordinal`,
    )
    .all(JSON.stringify(eventIds)) as Array<{
    event_id: string;
    ref_id: string;
    role: ActivityExternalRefDescriptorDto["role"];
    authority: ActivityExternalRefDescriptorDto["authority"];
    version_or_digest: string;
    current_availability: ActivityExternalRefDescriptorDto["availability"];
  }>;
  return groupDescriptors(
    rows.map((row) => ({
      eventId: row.event_id,
      descriptor: {
        refId: row.ref_id,
        role: row.role,
        authority: row.authority,
        versionOrDigest: row.version_or_digest,
        availability: row.current_availability,
      },
    })),
  );
}

function groupDescriptors<T>(
  rows: Array<{ eventId: string; descriptor: T }>,
): Map<string, T[]> {
  const result = new Map<string, T[]>();
  for (const { eventId, descriptor } of rows) {
    const items = result.get(eventId) ?? [];
    items.push(descriptor);
    result.set(eventId, items);
  }
  return result;
}
