# dsh-clinepass/checks

clinepass 自己的回归检查。**本机跑，不随包发布** —— `package.json` 的 `files` 里没有
`checks/`，所以不会进 npm / GitHub 包。

| 脚本 | 查什么 |
|---|---|
| `dsh-clinepass-streaming-gate-check.mjs` | 用**真实 OpenAI SDK** 跑一遍流式钉渠道门：`data: [DONE]` 被扣到裁决之后，不能让 SDK 装配失败 |
| `dsh-clinepass-buffering-repro.mjs` | 分片节奏回归：`off` 与 `strict` 必须同样逐帧转发（退化成「先读完再放行」会毁掉 TPS 测量） |

```bash
node ~/Documents/Projects/dsh/dsh-clinepass/checks/dsh-clinepass-streaming-gate-check.mjs
node ~/Documents/Projects/dsh/dsh-clinepass/checks/dsh-clinepass-buffering-repro.mjs
```

改门逻辑 / 分片逻辑后必跑；清单见 [project-map.md](../../project-map.md) §2.2 与 §4。
