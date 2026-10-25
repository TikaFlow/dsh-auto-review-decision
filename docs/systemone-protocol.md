# SystemOne 决策接口协议

SystemOne（TypeSafe System One，即 Jev 协议）是**非对话、非流式**的结构化决策接口：发送一份 `state` 与一组带类型的问题，一次前向推理返回每个问题的概率分布，不生成文本。

多个厂商实现同一线协议（TypeSafe/Jev、Concentrate、OpenRouter、vLLM、llama.cpp、TrueFoundry、阿里云百炼等），字段形状基本一致，差异集中在可选字段与取值范围。类型声明见 `src/systemone.ts`。

## 端点与认证

| 项 | 值 |
|---|---|
| 方法 | `POST` |
| 路径 | `/v1/systemone`（部分实现另有别名，如 `/evaluate`、`/decisions`、`/compatible-mode/v1/systemone`） |
| 请求头 | `Content-Type: application/json` |
| 认证 | `Authorization: Bearer <API_KEY>`；部分实现用自定义头（如 `X-API-Key`、`LUNAROUTE-API-KEY`） |
| 幂等 | 可选请求头 `Idempotency-Key`，由调用方生成 |

## 请求体

```json
{
  "model": "jev-1.13.0",
  "state": { "cwd": "/project" },
  "questions": {
    "allowed": { "type": "noul", "instructions": "是否应放行该调用？" }
  }
}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `model` | string | 视实现 | 托管服务必填；引擎固定单模型的自建实现忽略或省略 |
| `state` | string \| object \| array | 是 | 待判定内容，对象与数组发送前序列化 |
| `questions` | object | 是 | 至少一条；键为调用方自选 id，响应按同样 id 回填 |
| `images` | string[] | 否 | base64 data URI，仅接受图片的模型支持 |
| `videos` | string[] | 否 | base64 data URI，仅接受视频的模型支持 |

## 问题类型

| type | 问什么 | criteria 形状 | 答案字段 |
|---|---|---|---|
| `noul` | 一个命题是否成立 | 可省略；或 `{"true": 说明, "false": 说明}` | `noul` |
| `choice` | 在封闭选项集中选一个 | 必填，选项名 → 说明（可为 `null`），1–255 项 | `choice`、`confidence`、`probabilities` |
| `score` | 落在有序档位上的位置 | 必填，档位说明数组，按低到高，2–10 档 | `score`、`legend`、`probabilities`、`confidence` |

`instructions` 为问题的自然语言表述。多数实现要求必填；部分实现省略时以问题 id 作为问题本身，因此 `is_refund_request` 这类自解释 id 可单独使用。`instructions` 与 `criteria` 均可接受结构化 JSON，不限于字符串。

## 响应体

```json
{
  "model": "jev-1.13.0",
  "answers": {
    "allowed": { "type": "noul", "noul": 0.93 }
  },
  "usage": { "input_tokens": 125 },
  "latency_ms": 52.9
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `model` | string | 实际作答的模型 |
| `answers` | object | 与请求 `questions` 的 id 一一对应 |
| `usage` | object | `input_tokens` 必有；`output_tokens`、`total_tokens` 视实现 |
| `id` / `object` / `created` | string / string / number | 部分实现返回 |
| `request_id` | string | 请求追踪 id，部分实现返回 |
| `latency_ms` / `evaluation_time_ms` | number | 服务端耗时，部分实现返回 |

### 答案字段语义

- **`noul`**：P(真)，取值 0–1。`0.5` 表示**无法判定**，而非“中等为真”。该类型**没有** `confidence` 字段，数值本身即确定性。
- **`choice`**：`choice` 为选中选项名；`probabilities` 覆盖全部选项，总和为 1。
- **`score`**：`score` 是档位序号的**概率加权期望**（从 0 起算），可为小数，因此会落在两档之间。`legend[round(score)]` 给出最接近的档位名，但这**不一定**是概率最高的档位；要取最可能档位应看 `probabilities` 的最大项。
- **`confidence`**：0–1 的独立确定性信号。它是概率分布的集中程度，**不等于** `probabilities` 的最大值，二者不可互相推算。该字段可能缺失，缺失时应视为未知。

## 稳定性与阈值

同一请求的返回值会有小幅波动，量级约 `±0.02`（不同实现、批处理组成、前缀缓存命中情况都会影响）。因此**应基于阈值判定，而非精确相等比较**。

`confidence` 低不代表判断错误：多个选项都合理时概率会分散，`confidence` 随之降低，但模型判断仍可能是恰当的。

## 常见限制

| 限制 | 典型值 |
|---|---|
| 单请求 token 上限 | 64k |
| `state` 加最长问题的 token 上限 | 32k |
| `choice` 选项数 | 1–255 |
| `score` 档位数 | 2–10 |
| 输出 token | 不计费（不生成文本） |

## 与对话接口的差异

| 维度 | 对话接口 | SystemOne |
|---|---|---|
| 输出 | 生成文本，需解析 | 直接返回结构化概率，无需解析 |
| 流式 | 支持 | 不支持 |
| 采样参数 | temperature 等 | 不适用 |
| 延迟与成本 | 随输出长度增长 | 与输出长度无关 |
| 确定性 | 需固定采样参数 | 仍存在小幅波动 |

## 实现差异备忘

- `model` 字段：托管服务必填；自建单模型服务忽略该字段，响应中仍回报实际模型。
- `noul` 的 `probabilities` 与 `confidence`：部分实现（如 vLLM）返回，TypeSafe 原生不返回。
- `score` 的 `criteria`：多数实现要求至少 2 档，部分实现接受 1 档。
- `choice` 的 `criteria`：部分实现允许直接传选项名数组，等价于各选项说明为 `null`。
- 错误响应形状未统一，字段随实现而异。

## 参考

- TypeSafe System One API：<https://docs.system-one.dev/en/docs/api>
- Concentrate：<https://concentrate.ai/docs/api-reference/endpoint/systemone>
- vLLM Structured Decisions：<https://docs.vllm.ai/en/latest/models/structured_decisions_models>
- 阿里云百炼决策模型：<https://help.aliyun.com/en/model-studio/decision-model-api>
- llama.cpp Decision Models：<https://huggingface.co/blog/ggml-org/decision-models-in-llamacpp>
- TrueFoundry AI Gateway：<https://truefoundry.com/docs/ai-gateway/decisions>
