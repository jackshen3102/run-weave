import { createHash } from "node:crypto";
// No fixtures or secret logging: read the actual owner scope after a deploy or restore.
export async function authenticatedReadback(config, credentials, sql) {
  const base = config.apiURL.replace(/\/$/, "");
  const request = async (route, options = {}) => {
    const response = await fetch(base + route, {
      signal: AbortSignal.timeout(30000),
      ...options,
    });
    if (!response.ok)
      throw new Error(
        `Authenticated readback failed (HTTP ${response.status})`,
      );
    return response;
  };
  const login = await (
    await request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(credentials),
    })
  ).json();
  const headers = { Authorization: `Bearer ${login.accessToken}` };
  try {
    const info = await (
      await request("/api/suiji/v1/info", { headers })
    ).json();
    const identity = JSON.parse(
      await sql(
        "SELECT json_build_object('serverId',server_id,'ownerId',id) FROM server_identity CROSS JOIN owners",
      ),
    );
    if (
      info.serverId !== identity.serverId ||
      info.ownerId !== identity.ownerId ||
      info.protocolVersion !== 1
    )
      throw new Error("Readback identity/protocol mismatch");
    let cursor = null,
      count = 0;
    do {
      const page = await (
        await request(
          "/api/suiji/v1/records?limit=100" +
            (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""),
          { headers },
        )
      ).json();
      for (const record of page.items) {
        if (!/^[a-f0-9-]{36}$/.test(record.id))
          throw new Error("Invalid returned record ID");
        const stored = JSON.parse(
          await sql(
            `SELECT snapshot FROM record_revisions WHERE record_id='${record.id}' AND version=${Number(record.version)}`,
          ),
        );
        if (
          record.body !== stored.body ||
          record.version !== stored.version ||
          record.taskStatus !== stored.taskStatus ||
          JSON.stringify(record.attachments) !==
            JSON.stringify(stored.attachments)
        ) {
          // JSONB may reorder object keys; compare canonical attachment fields below.
          const fields = (items) =>
            items.map((a) => [
              a.id,
              a.kind,
              a.fileName,
              a.mimeType,
              a.byteSize,
              a.position,
            ]);
          if (
            record.body !== stored.body ||
            record.version !== stored.version ||
            record.taskStatus !== stored.taskStatus ||
            JSON.stringify(fields(record.attachments)) !==
              JSON.stringify(fields(stored.attachments))
          )
            throw new Error("Record/snapshot readback mismatch");
        }
        count++;
      }
      cursor = page.nextCursor;
    } while (cursor);
    if (count !== Number(await sql("SELECT count(*) FROM records")))
      throw new Error("Readback record count mismatch");
    const attachments = JSON.parse(
      await sql(
        "SELECT coalesce(json_agg(json_build_object('id',id,'sha256',sha256)), '[]'::json) FROM attachments",
      ),
    );
    for (const attachment of attachments) {
      const response = await request(
        "/api/suiji/v1/attachments/" + attachment.id + "/content",
        { headers },
      );
      const hash = createHash("sha256");
      for await (const chunk of response.body) hash.update(chunk);
      if (hash.digest("hex") !== attachment.sha256)
        throw new Error("Authenticated attachment readback mismatch");
    }
    return {
      records: count,
      attachments: attachments.length,
      schemaVersion: info.schemaVersion,
    };
  } finally {
    await request("/api/auth/logout", { method: "POST", headers }).catch(
      () => {},
    );
  }
}
