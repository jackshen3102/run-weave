import type { ExperienceRecord } from "@runweave/shared/experience";
import type { LearningFact } from "./learning-source";

function terms(text: string): Set<string> {
  const result = new Set<string>();
  const normalized = text.normalize("NFKC").toLowerCase();
  for (const segment of normalized.split(/(\p{Script=Han}+)/u)) {
    if (/^\p{Script=Han}+$/u.test(segment)) {
      const characters = [...segment];
      for (let index = 0; index < characters.length - 1; index++)
        result.add(characters[index]! + characters[index + 1]!);
    } else {
      for (const word of segment.match(/[\p{L}\p{N}]+/gu) ?? [])
        if (word.length >= 2) result.add(word);
    }
  }
  return result;
}

/** Background comparison candidates, never permission to merge or revive a record. */
export function selectLearningBaseline(
  records: ExperienceRecord[],
  facts: LearningFact[],
): ExperienceRecord[] {
  const query = new Set(facts.flatMap((fact) => [...terms(fact.text)]));
  const documents = records.map((record) => ({
    record,
    topic: terms([record.title, ...record.triggers.flat()].join("\n")),
    context: terms([record.applicability, ...record.actions].join("\n")),
  }));
  const frequency = new Map<string, number>();
  for (const document of documents)
    for (const term of new Set([...document.topic, ...document.context]))
      frequency.set(term, (frequency.get(term) ?? 0) + 1);
  const weight = (term: string) =>
    Math.log(1 + records.length / (frequency.get(term) ?? 1));
  const scoreTerms = (words: Set<string>) => {
    let score = 0;
    for (const word of words) if (query.has(word)) score += weight(word);
    return score / Math.sqrt(Math.max(1, words.size));
  };
  return documents
    .map(({ record, topic, context }) => ({
      record,
      score: 3 * scoreTerms(topic) + scoreTerms(context),
    }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.record.id.localeCompare(b.record.id))
    .slice(0, 50)
    .map(({ record }) => record);
}
