# Connector Abstraction Cleanup

Feature Name: connector-cleanup
Updated: 2026-06-29

## Description

删除 `src/connectors/` 整个目录（4 个文件），清理架构文档中对 connector 抽象层的描述。这是一个纯删除任务，无新增代码，无 schema 变更，无配置变更。

## Architecture

清理前：
```
src/
├── connectors/          ← 删除整个目录
│   ├── connector.ts
│   ├── telegram-connector.ts
│   ├── stub-email-connector.ts
│   └── stub-web-connector.ts
├── channels/telegram/   ← 实际消息流，保留不动
├── domain/
└── runtime/
```

清理后：
```
src/
├── channels/telegram/   ← 唯一渠道实现
├── domain/
└── runtime/
```

## Components and Interfaces

### 删除文件清单

| 文件 | 行数 | 说明 |
|------|------|------|
| `src/connectors/connector.ts` | 32 | Connector 接口定义 |
| `src/connectors/telegram-connector.ts` | 46 | Telegram 实现，与实际消息流重复且功能更弱 |
| `src/connectors/stub-email-connector.ts` | ~15 | 纯 throw 占位 |
| `src/connectors/stub-web-connector.ts` | ~15 | 纯 throw 占位 |

### 文档更新

#### `docs/architecture.md`

- 移除"Connector 层"或"多渠道接入"相关章节（如有）
- 在"未来方向"章节新增一条："多渠道接入（Email/Web Chat）为后续扩展方向。当前仅 Telegram 渠道，未来新增渠道时基于实际需求设计消息归一化抽象。"

#### `README.md`

- "项目定位"部分提到"Email、Web Chat 等 connector 保留扩展骨架，暂未实装"改为"当前核心入口是 Telegram；Email、Web Chat 等渠道为后续扩展方向"

## Data Models

无变更。

## Correctness Properties

1. **零引用安全**：`src/connectors/` 在 `src/` 内零 import，删除不影响编译
2. **测试不变**：现有 25 个测试不涉及 connector，删除后全部通过
3. **运行时不变**：`main.ts` 只引用 `channels/telegram/`，删除 connectors 不影响启动
4. **文档一致**：清理后文档不再提及已删除的代码

## Error Handling

无运行时错误场景。唯一风险是遗漏的 import 引用，由 TypeScript 编译检查保证。

## Test Strategy

### 验证步骤

1. 删除 4 个文件和目录
2. `grep -r "connectors" src/` 确认零引用
3. `npm run verify` 通过（check + 25 tests + audit）
4. 检查文档更新

### 回归验证

- 现有 `test/core.test.ts` 中的 telegram helpers 测试（5 个）仍通过
- web console 测试（4 个）仍通过
- 配置测试（7 个）仍通过

## References

[^1]: (src/connectors/connector.ts) - 待删除的接口定义
[^2]: (src/connectors/telegram-connector.ts) - 待删除的 Telegram 实现，功能弱于实际消息流
[^3]: (src/channels/telegram/messages.ts) - 实际消息流，保留不动
[^4]: (src/runtime/main.ts) - 启动入口，只引用 channels/telegram
