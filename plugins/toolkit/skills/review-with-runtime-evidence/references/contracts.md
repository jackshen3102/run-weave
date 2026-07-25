# 输入与裁决合同

## 静态审查 Manifest

`run-static-review.mjs` 接收一个 JSON manifest：

```json
{
  "cases": [
    {
      "id": "checkpoint-env-safety",
      "requirements": [
        {
          "id": "REQ-CHECKPOINT-SECRET",
          "text": "Review checkpoint must reject every .env.* path before staging."
        }
      ],
      "patchPath": "./patches/checkpoint-env-safety.diff"
    }
  ]
}
```

约束：

- `id` 在 manifest 内唯一；
- 每个 Case 至少包含一个稳定 requirement ID；
- `patchPath` 相对 manifest 所在目录解析；
- diff 是三个 Reviewer 唯一可见的代码边界。

执行：

```bash
node <skill-dir>/scripts/run-static-review.mjs \
  --manifest=<manifest.json> \
  --output=<artifact-dir>
```

只生成 prompt、schema 和哈希而不调用模型：

```bash
node <skill-dir>/scripts/run-static-review.mjs \
  --manifest=<manifest.json> \
  --output=<artifact-dir> \
  --prepare-only
```

主要输出：

- `prepared.json`：模型、Case、需求、patch 路径与 SHA-256；
- `prompts/`：三个模型收到的相同 prompt；
- `raw/`：逐模型、逐次尝试的 stdout、stderr 和结构化结果；
- `result.json`：
  - `majorityCandidates`：同一 requirement 获得至少两个独立 P0/P1；
  - `singletonCandidates`：只有一个独立 P0/P1；
  - `unmappedSevere`：未绑定 requirement 的严重 finding，必须人工按行为不变量聚类；
  - `protocolFailures`：连续两次仍失败的模型调用。

`protocolFailures` 不得计作反对票或“未发现问题”。

## 运行时裁决输入

每个多数候选写一个 JSON：

```json
{
  "candidateId": "checkpoint-env-safety:REQ-CHECKPOINT-SECRET",
  "staticSevereVotes": 3,
  "trigger": "established",
  "targetObservation": "fail",
  "cleanObservation": "pass",
  "runtimeEvidenceDisagreement": "none",
  "evidenceRefs": [
    "artifact://runtime/checkpoint-target.json",
    "artifact://runtime/checkpoint-clean.json"
  ]
}
```

字段枚举：

- `staticSevereVotes`：`0` 到 `3`；
- `trigger`：`established`、`not_established`；
- `targetObservation`：`pass`、`fail`、`not_run`；
- `cleanObservation`：`pass`、`fail`、`not_run`；
- `runtimeEvidenceDisagreement`：`none`、`severe`；
- `evidenceRefs`：至少一条可回查的真实运行时证据。

执行：

```bash
node <skill-dir>/scripts/classify-runtime-verdict.mjs \
  --input=<runtime-input.json> \
  --output=<runtime-verdict.json>
```

裁决器只实现固定真值表，不判断日志、DOM 或业务含义。调用技能的 Agent 必须先确认：

1. 触发条件来自受支持的生产入口；
2. target 和 clean 除 patch 外保持一致；
3. `fail` / `pass` 与 requirement 的可观察结果一致；
4. evidence ref 可以回查；
5. 资源已经清理或明确记录清理阻塞。

## 辩论输入

只有裁决器返回 `debate_required` 时才构造辩论包。三个模型必须收到同一份：

- candidate ID、requirement 和原始静态 proposals；
- target/clean 的命令、环境和身份；
- 不可变原始证据；
- 双方对证据含义的精确分歧。

辩论不得新增伪造状态、修改实验条件或用静态推测替代运行时事实。
