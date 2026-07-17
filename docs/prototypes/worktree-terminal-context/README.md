# Worktree Terminal Context Prototype

Runweave Terminal 的 Worktree 导航原型。当前只表达选定的交互方案，不代表 Git、终端或 Preview 协议已经实现。

## 打开

```bash
python3 -m http.server 6188 --directory docs/prototypes/worktree-terminal-context
```

访问：

```text
http://127.0.0.1:6188/
```

## 当前交互

```text
Project
├─ 左：Worktree 列表
└─ 右：完整终端区
   ├─ Terminal tabs
   └─ Terminal + Preview
```

- 顶部 Project tabs 负责切换项目。
- Project 下方，Worktree 列表与完整终端区左右平级。
- 第一项是当前项目根目录对应的主节点，始终置顶且不可取消固定。
- 主节点直接使用父 Project ID；其他 Worktree 使用父 Project ID 与名称生成的子 Project ID。
- 每项第一行展示 Worktree 名称，第二行展示实际分支；列表不展示文件 diff 或变更数。
- 选中 Worktree 后，右侧所有操作只使用该行的 Project ID；没有子 Project 时使用父 Project ID。
- 切换 Worktree 时，Terminal、cwd、Changes、Preview 和 Agent Team 一起切换。
- Worktree 可以固定到列表顶部；非固定项按最近活跃时间排序。
- Worktree 栏可以折叠成窄栏，并通过同一位置重新展开。
- 列表来自 Git Worktree 自动发现，不提供新增或删除入口。

## 原型边界

- 使用静态 mock 数据，不连接真实 Git、PTY、WebSocket 或 Preview API。
- 固定与折叠状态仅用于交互演示，正式实现需要持久化。
- 产品核心功能是 Project/Worktree/Terminal 联动、固定和折叠；原型没有可见的辅助控件。
- 已放弃独立 `worktreeId` 方案，原型内部只保留一个当前生效的 Project ID。
- `prototype-preview.png` 是 1440 × 900 的当前方案截图。

## 验证

- 2026-07-18 已使用 `$toolkit:playwright-cli` 验证父/子 Project ID、主节点切换、固定、36px 折叠和 Preview 联动。
- 页面无横向溢出，浏览器 console 为 0 error / 0 warning。
