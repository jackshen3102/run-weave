---
name: doc-coauthoring
description: "Co-author documentation, proposals, technical specs, and decision docs from available context, refining the draft with user feedback. Use for substantive writing or revision; simple wording edits do not need this workflow."
metadata:
  risk: unknown
  source: community
  date_added: "2026-02-27"
---

# Doc Co-Authoring

Produce a document that its intended readers can understand and use. Adapt the collaboration to the task: draft directly when context is sufficient; explore decisions with the user when they ask for deeper co-authoring or the content depends on unresolved choices.

## Establish the context

- Infer the audience, purpose, desired outcome, format, and scope from the request and conversation. Read the existing document, supplied template, and relevant sources before asking for information already available.
- For technical documents, check relevant code and current project documentation. Distinguish current behavior, proposed changes, and unresolved assumptions.
- Use available tools to retrieve relevant sources within the task's scope. If a source is inaccessible, identify the specific missing information and continue work that does not depend on it.
- Ask a focused question only when a missing fact or decision materially affects the document and cannot be resolved from context. Do not require an initial questionnaire or a fixed number of questions.
- If the user is sharing background, accept rough notes and organize them. Do not ask for exhaustive context unrelated to the intended document.

Begin drafting once the purpose and essential content are clear. There is no separate approval step for moving between writing activities.

## Draft according to the task

For a straightforward request, produce a coherent draft using the user's template or an appropriate structure. Choose section order and depth based on what readers need to understand or decide. Do not create an empty scaffold as a mandatory intermediate deliverable.

For substantial co-authoring or an unsettled proposal:

- Start with the decision or section whose uncertainty affects the rest of the document.
- Present alternatives only when they represent meaningful choices; explain the recommended direction and trade-offs. Do not generate options to meet a quota.
- Ask the user to choose only when the choice depends on their goals or preferences. Select routine organization and wording yourself.
- Draft the settled content while dependent decisions remain open. Clearly identify unresolved points instead of inventing facts.

For example, a request to document an existing API can start from its implementation and a draft. A proposal whose recommendation depends on an unknown rollout constraint needs that decision clarified, while its established background can still be written.

## Refine with the user

- Accept comments, freeform feedback, or direct user edits. Do not require numbered keep/remove/combine selections or ask the user to avoid editing the document.
- Apply feedback to the relevant passages and carry established terminology and style into later sections. Preserve unrelated user changes.
- Re-read the current document before editing when the user may have changed it.
- Ask follow-up questions only when feedback leaves a consequential ambiguity. Do not require confirmation after each section or another review after a fixed number of iterations.
- Follow requests to skip discussion, change the structure, or move directly to a finished draft without reconfirming the process.

## Check the document as a reader

Before delivery, check the whole document for:

- A clear purpose, supported claims, and enough context for its intended audience.
- Consistent terms, decisions, and technical details across sections.
- Missing prerequisites or unexplained assumptions that could cause a wrong decision.
- Repetition, contradictions, generic filler, and broken or unsupported references.

For instructions and decision documents, consider whether a reader could carry out the intended action or explain the decision from the document alone. Use realistic reader questions where they reveal a gap; do not impose a question count.

Independent reader review is optional when requested or when consequential ambiguity warrants it and delegation is permitted. Give the reviewer the document and intended audience without supplying hidden background or expected answers. Revise based on concrete misunderstandings; do not require one agent per question or repeated reviews without new findings. If independent review is unavailable, complete the available checks and state any material limitation instead of requiring the user to open another chat.

Only claim independent reader review when it actually occurred. Checking prose does not establish that a described implementation works.

## Deliver

Use the user's requested destination and format. For repository files, follow the project's documentation placement and validation rules; for a conversational draft, return the text without creating extra files by default. Use the editing tools available in the environment.

Deliver once the requested content is complete, relevant checks are done, and material open questions are resolved or explicitly identified. Provide the document or its link and briefly note any remaining decisions or verification gaps. Do not add an automatic final approval round, process appendix, or separate review report.
