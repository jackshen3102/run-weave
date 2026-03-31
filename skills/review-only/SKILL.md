---
name: review-only
description: Use only when the user explicitly asks to run the review-only skill by name and wants code or architecture review without any implementation changes.
---

# Review Only

## Purpose

Use this skill to perform high-level critical review first, then code-level review.

Primary objective:

- find direction-level mistakes before local code defects
- challenge whether the current architecture is the right architecture
- surface better alternatives (build-vs-buy, simplify-vs-customize, platform defaults vs self-built)

## Activation Rule

- This skill is manual.
- Apply it only when the user explicitly requests `review-only` (or clearly says “only review, do not modify code”).
- Do not auto-apply for normal coding tasks.

## Hard Constraints

- Do not edit any file.
- Do not run any write operation (`apply_patch`, redirection writes, formatter fixes, code generation).
- Do not commit, stash, rebase, or change git state.
- Do not propose partial implementation in place of findings.

## Review Method (Top-Down, Mandatory Order)

1. Problem framing review (are we solving the right problem?)
2. System/architecture review (is this the right shape?)
3. Build-vs-buy / self-built wheel review (did we reinvent existing capability?)
4. Operability and lifecycle review (can this run, evolve, and fail safely?)
5. Code-level correctness review (only after 1-4)

Do not start with line-by-line code comments.

## Review Scope

1. Code correctness and regression risk.
2. Architecture boundaries and coupling/cohesion.
3. Test strategy and coverage blind spots.
4. Operational risks (config, scripts, CI gate logic, observability).
5. Maintainability (readability, extensibility, ownership clarity).
6. Strategic fitness:
   - requirement-to-design traceability
   - total complexity vs business value
   - opportunity to remove components instead of improving components
7. Alternatives:
   - at least one simpler architecture
   - at least one “use existing platform/tooling” option
   - tradeoff comparison (cost, risk, delivery speed, lock-in)

## Aggressive Review Heuristics

- Assume current architecture may be wrong until proven otherwise.
- Prefer deleting layers over polishing layers if outcomes are equal.
- Flag custom infrastructure when a mature default could replace it.
- Flag local optimizations that increase global system complexity.
- Treat “works now” as insufficient if operational burden is high.

## Review Intensity (Adaptive)

Use lightweight review for simple changes, and hardcore review for complex/risky changes.

### Lightweight Mode (default for simple changes)

Use when:

- single-module changes with low coupling
- copy/style/small logic fixes
- no boundary, protocol, infra, or deployment impact

Expectations:

- concise findings
- architecture section can be brief or explicitly "no architecture concern"
- no mandatory multi-option architecture comparison

### Hardcore Mode (for complex/risky changes)

Trigger when any of these apply:

- cross-module or cross-service changes
- protocol/schema/contract changes
- infra/tooling/gate changes (build, test, deploy, quality gate)
- security/auth/session/runtime behavior changes
- meaningful operational or cost impact

Expectations:

- provide at least 2 materially different architecture options
- include tradeoffs per option: delivery speed, complexity, operational risk
- explicitly state:
  - recommended option (with reason)
  - not-recommended option (with reason)

## Required Output Format

- Findings first, ordered by severity (`P1` -> `P2` -> `P3`).
- Each finding includes:
  - short title
  - why it is a risk
  - concrete file + line reference
  - actionable fix direction (without implementing)
- If no major issues are found, state that explicitly and list residual risks/testing gaps.

Use two finding buckets in this order:

1. `Architecture / Strategy Findings` (mandatory, can be empty only with explicit justification)
2. `Code / Implementation Findings`

Each architecture finding must include:

- current decision
- why it may be wrong at system level
- better candidate approach
- migration/transition risk notes

In Hardcore Mode, at least 2 candidate approaches are mandatory for the architecture section.

## Review Behavior

- Be critical and evidence-based.
- Avoid style-only nitpicks unless they create real risk.
- Validate suspected issues with commands/reads before reporting.
- Prefer architecture and behavior risks over cosmetic comments.
- Explicitly call out “self-built wheel” cases with replacement candidates.

!!! 必须用中文回复
