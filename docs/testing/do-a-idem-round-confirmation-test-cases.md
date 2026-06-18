# Do-A-IDEM Round Confirmation Test Cases

- Date: 2026-06-17
- Scope: Orchestrator Do-A-IDEM `requireHumanConfirmationEachRound` option
- Rule: After execution starts, do not modify this document. If a case is invalid, stop execution and report why.

## Prerequisites

- Work from `/Users/bytedance/Code/browser-hub/feature`.
- Browser validation must use `$playwright-cli`.
- Use an authenticated local Runweave frontend/backend.
- If an old active Orchestrator run blocks the configuration screen, mark only that old run as `failed` before starting these cases.
- Do not add unit tests or non-E2E test files.

## Static Verification

### DAI-RC-001 Typecheck And Lint

Steps:

1. Run `pnpm --filter ./packages/shared typecheck`.
2. Run `pnpm --filter ./backend typecheck`.
3. Run `pnpm --filter ./frontend typecheck`.
4. Run `pnpm --filter ./backend lint`.
5. Run `pnpm --filter ./frontend lint`.

Expected:

- All commands exit with code `0`.

## Browser And API Verification

### DAI-RC-002 Configuration Toggle Is Available

Steps:

1. Open the local frontend with `$playwright-cli`.
2. Open a terminal workspace.
3. Open the Orchestrator panel.
4. Confirm the new run configuration view is visible.

Expected:

- The configuration view includes a checkbox labeled `每一轮都需要人工确认`.
- The checkbox is unchecked by default.
- The default roles are `plan_reviewer`, `code_agent`, and `code_reviewer`.

### DAI-RC-003 Toggle Off Keeps Existing Automatic Code To Code Review Transition

Steps:

1. Create a new Orchestrator run with `每一轮都需要人工确认` unchecked.
2. Confirm the new run starts with `currentPhase=plan`.
3. Dispatch `code_agent` for a smoke goal.
4. Complete the `code_agent` worker through the existing terminal completion path with a summary.
5. Refresh the Orchestrator panel.

Expected:

- After dispatch, `currentPhase=code`.
- After the worker result, `currentPhase=code_review`.
- `status` stays `running`.
- No `pendingRoundConfirmation` is present.

### DAI-RC-004 Toggle On Creates Pending Round Confirmation

Steps:

1. Finish or fail the previous smoke run so the configuration view is visible.
2. Create a new Orchestrator run with `每一轮都需要人工确认` checked.
3. Confirm the new run starts with `currentPhase=plan`.
4. Dispatch `code_agent` for a smoke goal.
5. Complete the `code_agent` worker through the existing terminal completion path with a summary.
6. Refresh the Orchestrator panel.

Expected:

- After dispatch, `currentPhase=code`.
- After the worker result, `status=need_human`.
- `currentPhase` remains `code`.
- `pendingRoundConfirmation` is present and contains `fromPhase=code`, `nextPhase=code_review`, the smoke `goalId`, and the worker summary.
- The UI shows a `轮次确认` card.
- The card has `通过，进入下一阶段` enabled.
- The card has `不通过，返回修改` disabled until a reason is entered.

### DAI-RC-005 Round Confirmation Reject Requires Reason

Steps:

1. While the run is waiting on the `DAI-RC-004` pending round confirmation, call the round confirmation API with `verdict=rejected` and no `reason`.

Expected:

- The API returns HTTP `400`.
- The run remains at `status=need_human`.
- The same `pendingRoundConfirmation` remains present.

### DAI-RC-006 Round Confirmation Approval Advances To Next Phase

Steps:

1. While the run is waiting on the `DAI-RC-004` pending round confirmation, click `通过，进入下一阶段`.
2. Refresh the Orchestrator panel.

Expected:

- `status=running`.
- `currentPhase=code_review`.
- `pendingRoundConfirmation` is cleared.
- `roundConfirmations[]` contains an `approved` record for the smoke goal.
- The UI shows the round confirmation record.

### DAI-RC-007 Existing Human Gates Still Work

Steps:

1. In the same toggle-on run, dispatch `code_reviewer` for a smoke review goal.
2. Complete the `code_reviewer` worker through the existing terminal completion path with a summary.
3. Refresh the Orchestrator panel.
4. Click `通过，进入提交`.
5. Refresh the Orchestrator panel.

Expected:

- After the `code_reviewer` worker result, `status=need_human`.
- `currentPhase=human_verify`.
- No `pendingRoundConfirmation` is created for this transition because `human_verify` is already a human gate.
- After clicking `通过，进入提交`, `status=running`.
- `currentPhase=finalize`.
- `humanGateVerdicts[]` contains an `approved` record for `human_verify`.
