import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifacts = path.resolve(pkg, "../../.runweave/suiji/mapping");
const endpoint = process.env.SUIJI_VERIFY_URL;
const token = process.env.SUIJI_VERIFY_TOKEN;
const reviewId = process.env.SUIJI_VERIFY_REVIEW_ID;
if (!endpoint || !token)
  throw new Error(
    "SUIJI_VERIFY_URL and SUIJI_VERIFY_TOKEN required for real HTTP mapping",
  );
await mkdir(artifacts, { recursive: true, mode: 0o700 });
for (const [name, route] of [
  ["info", "/api/suiji/v1/info"],
  ["page", "/api/suiji/v1/records?limit=100"],
  ...(reviewId
    ? [["review", "/api/suiji/v1/reviews/" + encodeURIComponent(reviewId)]]
    : []),
]) {
  const response = await fetch(endpoint + route, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`${name} HTTP ${response.status}`);
  const body = await response.text();
  await writeFile(path.join(artifacts, name + ".json"), body, { mode: 0o600 });
}
// Compile the SAME DTO definitions consumed by the iOS app, decode and re-encode actual HTTP JSON.
await writeFile(
  path.join(artifacts, "main.swift"),
  `import Foundation
let root = CommandLine.arguments[1]
let info = try JSONDecoder().decode(ServiceInfo.self, from: Data(contentsOf: URL(fileURLWithPath: root + "/info.json")))
let page = try JSONDecoder().decode(RecordPage.self, from: Data(contentsOf: URL(fileURLWithPath: root + "/page.json")))
guard info.protocolVersion == 1, !page.items.isEmpty else { fatalError("Real fixture records required") }
try JSONEncoder().encode(page).write(to: URL(fileURLWithPath: root + "/roundtrip.json"))
${
  reviewId
    ? `let review = try JSONDecoder().decode(SuijiReview.self, from: Data(contentsOf: URL(fileURLWithPath: root + "/review.json")))
guard info.ai?.enabled == true, review.status == "completed", review.answer != nil else { fatalError("Actual completed review required") }
try JSONEncoder().encode(review).write(to: URL(fileURLWithPath: root + "/review-roundtrip.json"))`
    : ""
}
print("Decoded actual HTTP info and \\(page.items.count) records with production Swift DTOs")
`,
);
function run(argv) {
  const result = spawnSync(argv[0], argv.slice(1), { stdio: "inherit" });
  if (result.status !== 0) throw new Error("Swift mapping command failed");
}
run([
  "xcrun",
  "swiftc",
  path.join(pkg, "Sources/SuijiIOS/Contracts/Contracts.swift"),
  path.join(pkg, "Sources/SuijiIOS/Contracts/Reviews.swift"),
  path.join(artifacts, "main.swift"),
  "-o",
  path.join(artifacts, "mapping"),
]);
run([path.join(artifacts, "mapping"), artifacts]);
const { readFile } = await import("node:fs/promises");
const before = JSON.parse(
  await readFile(path.join(artifacts, "page.json"), "utf8"),
);
const after = JSON.parse(
  await readFile(path.join(artifacts, "roundtrip.json"), "utf8"),
);
for (const record of before.items) {
  const decoded = after.items.find((item) => item.id === record.id);
  for (const key of [
    "id",
    "kind",
    "body",
    "version",
    "createdAt",
    "updatedAt",
    "createdVia",
  ])
    if (decoded?.[key] !== record[key])
      throw new Error(`Mapping mismatch: ${key}`);
  if (
    (decoded.taskStatus ?? null) !== record.taskStatus ||
    JSON.stringify(
      decoded.attachments.map((a) => [
        a.id,
        a.kind,
        a.fileName,
        a.mimeType,
        a.byteSize,
        a.position,
      ]),
    ) !==
      JSON.stringify(
        record.attachments.map((a) => [
          a.id,
          a.kind,
          a.fileName,
          a.mimeType,
          a.byteSize,
          a.position,
        ]),
      )
  )
    throw new Error("Attachment/status mapping mismatch");
}
console.log(
  "Real HTTP -> production Swift Codable -> JSON fields and body scalars match",
);
if (reviewId) {
  const canonical = (value) => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.keys(value)
          .sort()
          .filter((key) => value[key] !== null)
          .map((key) => [key, canonical(value[key])]),
      );
    return value;
  };
  const review = JSON.parse(
    await readFile(path.join(artifacts, "review.json"), "utf8"),
  );
  const decoded = JSON.parse(
    await readFile(path.join(artifacts, "review-roundtrip.json"), "utf8"),
  );
  if (JSON.stringify(canonical(review)) !== JSON.stringify(canonical(decoded)))
    throw new Error("Review answer/citation/coverage mapping mismatch");
  console.log(
    "Actual completed CLI review, citations, versions and coverage match Swift Codable roundtrip",
  );
}
