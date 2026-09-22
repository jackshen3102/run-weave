import type { ExperienceRecord } from "@runweave/shared/experience";
import type { EvolutionRepository } from "@runweave/shared/evolution";
import type { ExperienceService } from "../experience/service";
import {
  contentVersion,
  itemId,
  publicContent,
  publicText,
} from "./projection";
import type { InboxSourceReader, PublishedItem } from "./types";

function body(record: ExperienceRecord) {
  // Experience has no separate statement field. Do not manufacture one from its title.
  return publicContent({
    statement: "",
    applicability: record.applicability,
    actions: record.actions,
    avoid: record.avoid,
    verification: record.verification,
  });
}
export class ExperienceInboxSource implements InboxSourceReader {
  readonly source = "experience";
  constructor(private readonly service: ExperienceService) {}
  async read(repositories: EvolutionRepository[]): Promise<PublishedItem[]> {
    const result: PublishedItem[] = [];
    for (const repository of repositories.filter((repo) => repo.available)) {
      const records = await this.service.publicationRecords(
        repository.paths[0]!,
      );
      for (const { view, revisions } of records) {
        if (
          !view.available ||
          view.record.repositoryId !== repository.repositoryId
        )
          continue;
        const record = view.record;
        const content = body(record);
        const version = contentVersion(content);
        const dates = [record, ...revisions]
          .filter((revision) => contentVersion(body(revision)) === version)
          .map((revision) => revision.updatedAt)
          .sort();
        result.push({
          ...content,
          itemId: itemId(this.source, repository.repositoryId, record.id),
          repositoryId: repository.repositoryId,
          projectName: publicText(repository.name),
          source: this.source,
          sourceId: record.id,
          sourceRevision: record.revision,
          kind: "experience",
          title: publicText(record.title),
          validationLabel: "经验·使用前核对适用条件",
          contentVersion: version,
          contentUpdatedAt: dates[0]!,
        });
      }
    }
    return result;
  }
}
