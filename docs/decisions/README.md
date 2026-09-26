# Architecture decision records

Create a decision record for changes to public protocols, storage, permissions, trust, package ownership, compatibility generations, licensing, or release security.

Name records `NNNN-short-title.md` and use this structure:

```markdown
# NNNN: Decision title

- Status: proposed | accepted | superseded
- Date: YYYY-MM-DD
- Owners: package or domain

## Context
## Decision
## Alternatives
## Security and privacy
## Compatibility and migration
## Validation
## Consequences
```

Accepted records are durable rationale, not a substitute for schemas or executable tests. Superseded records remain in Git and link to the replacing decision.

- [0015: ScriptAct 共享任务主干与统一模块合同](0015-scriptact-shared-task-runtime.md)

- [ADR 0016：项目语言服务与命令行归属](0016-project-language-and-cli-ownership.md)

- [0017: 长程上下文按段追加、按剩余轮数封段](0017-long-running-context.md)

- [0018: 子任务直接继承父任务的权限，不用声明](0018-sub-tasks-inherit-parent.md)

- [0019: 模型写的脚本只查语法，不查类型](0019-scripts-check-syntax-only.md)

- [0020: 效果不明不再等宿主核对](0020-no-host-reconciliation.md)

- [0021: 写入不再按决策依据拦](0021-no-decision-basis-write-gate.md)

- [0022: 命令确认只留成片毁掉、找不回来的](0022-confirm-only-mass-irreversible-commands.md)

- [0023: 读出来是连续正文，改的时候按路径写](0023-continuous-text-path-edits.md)

- [0024: 模块不用申请](0024-no-capability-requests.md)
- [0025: 收尾不再按读到的版本核对](0025-no-completion-read-check.md)
