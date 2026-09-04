---
name: grill-with-docs
description: Stress-test a feature or design through a repo-grounded interview while recording resolved domain language in CONTEXT.md and durable architectural decisions in ADRs. Use when a codebase needs both design alignment and a documentation trail; do not use for a discussion that should not modify project docs.
metadata:
  source: "https://github.com/mattpocock/skills/tree/main/skills/engineering/grill-with-docs"
  adapted_for: "Runweave Toolkit"
---

# Grill with Docs

Turn an unsettled feature or design into shared understanding and durable project knowledge. Combine a rigorous design interview with active domain modeling. Do not implement the design while this skill is active.

## Ground the discussion

Before asking a question:

1. Read the repository instructions and any plan or draft the user identified.
2. Locate the relevant `CONTEXT.md`. If the repository has `CONTEXT-MAP.md`, use it to select the bounded context; otherwise use the repository-level context.
3. Read relevant ADRs and inspect the code paths that can establish current behavior.

Finding facts is the agent's job. Answer questions from the repository or available tools instead of asking the user to rediscover facts.

## Run the grill

Map the design as a decision tree and resolve prerequisite decisions before dependent ones.

- Ask one high-value decision question at a time and wait for the user's answer.
- Give a recommended answer with the concrete reason and important trade-off.
- Challenge vague, overloaded, or contradictory terms. Propose one canonical term when that will make the model clearer.
- Use concrete scenarios and edge cases to test the boundaries between concepts.
- When the user's description conflicts with existing docs or code, show the evidence and ask which behavior is authoritative.
- Recompute the unresolved decision tree after every answer.

Do not start implementation, write a specification, or create tickets until the user confirms that shared understanding has been reached.

## Record resolved language

Update the relevant `CONTEXT.md` as soon as a domain term is resolved. Preserve the file's existing structure and vocabulary.

`CONTEXT.md` is a glossary:

- Define domain concepts, distinctions, relationships, and invariants in the project's language.
- Do not add implementation details, design alternatives, task lists, or specification content.
- Create the file lazily only after the first stable term is resolved.

If unrelated user changes already exist in the file, preserve them and edit only the resolved entry.

## Record durable decisions

Offer an ADR only when all three conditions are true:

1. Reversing the decision later would have meaningful cost.
2. A future reader would find the choice surprising without its context.
3. The decision resolves a real trade-off between credible alternatives.

If any condition is missing, do not create an ADR. Follow the repository's existing ADR convention; when none exists, use `docs/adr/` and continue its numeric sequence. Record the context, decision, alternatives, and consequences without turning the ADR into an implementation plan.

## Finish

The grill is complete only when every reachable decision branch is resolved and the user confirms shared understanding. Then report:

- the agreed design boundaries;
- the glossary entries and ADRs created or changed;
- any explicitly deferred questions.

If no term or decision met the documentation threshold, leave the repository unchanged and say so.
