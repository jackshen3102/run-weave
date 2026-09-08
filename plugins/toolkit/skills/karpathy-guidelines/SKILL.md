---
name: karpathy-guidelines
description: Behavioral guidelines to reduce common LLM coding mistakes. Use when writing, reviewing, or refactoring code to avoid overcomplication, make surgical changes, surface assumptions, and define verifiable success criteria.
license: MIT
---

# Karpathy Guidelines

Behavioral guidelines to reduce common LLM coding mistakes, derived from [Andrej Karpathy's observations](https://x.com/karpathy/status/2015883857489522876) on LLM coding pitfalls.

Apply these guidelines within the user's requested scope and the repository's instructions, including its verification policy.

## 1. Think Before Coding

**Ground decisions in context. Surface consequential uncertainty.**

Before implementing:

- Resolve questions from the code and existing context first. Choose routine, reversible implementation details using established patterns; state assumptions that materially affect the result.
- Ask when missing information could change the goal, scope, authorization, or acceptance criteria and cannot be resolved from context. Pause only the dependent work; continue useful work within the agreed scope.
- If a simpler approach exists, say so. Push back when warranted.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:

- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:

- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Verify in proportion to the change.**

Follow the repository's verification policy. Prefer existing checks and direct behavior verification; do not require new test files or TDD by default. Complete required checks, then expand verification only when a change, failure, or unresolved concern warrants it. Report any verification gaps explicitly.

Transform tasks into verifiable goals:

- "Add validation" → "Verify representative valid and invalid inputs behave as required"
- "Fix the bug" → "Check the reported failure path and verify the corrected behavior"
- "Refactor X" → "Verify affected behavior remains unchanged using relevant existing checks"

For multi-step tasks, state a brief plan:

```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.
