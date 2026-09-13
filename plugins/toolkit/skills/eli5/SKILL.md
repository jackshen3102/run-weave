---
name: eli5
description: Explain a topic like I'm a 5 year old. Use when the user types /eli5 followed by a topic or asks for a dead-simple picture explainer of how something works.
license: MIT
metadata:
  author: Thariq Shihipar
  source: https://github.com/anthropics/claude-plugins-community/blob/863e70dc7cff21a2facc749e40a7ecd1a5d19833/eli5/skills/eli5/SKILL.md
  adapted_for: Runweave Toolkit
  changes: Removed angle brackets from the discovery description and added a Codex topic fallback; original explanation instruction preserved.
---

# eli5

Explain like I'm someone who knows nothing about this topic, using a HTML artifact with big pictures and few words.

Topic: $ARGUMENTS

In Codex, use the topic supplied with `$toolkit:eli5` when `$ARGUMENTS` is not substituted.
