# 接口契约、Mock与状态约定

原contracts两份OpenAPI继续记录现有接口。新增contracts/dev-v2/openapi.mock.json只描述可运行Mock；interface-mapping.json逐项说明目标与真实接口的差异。不能把目标样例直接当作当前服务承诺。

## 使用Mock

先team:seed，再team:mock。读取本机随机账号文件，通过POST /dev/v2/login取得临时Bearer令牌。所有写操作除login/logout外要求Idempotency-Key；状态操作携带expected_version。回复标mock=true，表明不是院方或生产业务回执。

推荐直接运行team:test:mock观察成功和错误断言；无需手工复制真实密码进脚本。Mock不调用模型、不访问院方、不投递渠道。

| 编号 | 提供→消费 | 真实入口 | Mock入口 |
|---|---|---|---|
| IF-01 | B→A | `POST /api/public/acquisition-chat` | `POST /dev/v2/conversations/{id}/messages` |
| IF-02 | B→A | `POST /api/public/acquisition-lead` | `POST /dev/v2/conversations/{id}/contact` |
| IF-03 | B→A | `POST /api/admin/acquisition/handovers/{handoverId}/claim` | `POST /dev/v2/conversations/{id}/claim` |
| IF-04 | B→A | `POST /api/public/appointment-intakes` | `POST /dev/v2/conversations/{id}/appointment` |
| IF-05 | C→A | `内部server/huamei-knowledge.mjs与runtime-knowledge-index调用` | `GET /dev/v2/knowledge` |
| IF-06 | C→B/A | `GET /api/admin/identity；POST /auth/login` | `GET /dev/v2/identity` |
| IF-07 | C→B | `现有话术/资料领域能力待消费端冻结` | `无独立Mock端点` |
| IF-08 | A/B协作 | `现有前台完整JSON回复；后台/api/local/conversation-events为SSE通知` | `GET /dev/v2/events?after=0` |

## 协议边界

- **IF-01：** 同一Idempotency-Key同内容重放；不同内容409；最终消息按服务端seq合并。正式接口当前没有完整同构消息schema，需要兼容适配。
- **IF-02：** 真实表单接口另需service_consent=true及有效会话凭据；Mock只验证保存结果。不加OTP；不得向公开端暴露院方是否已有记录。
- **IF-03：** 真实接口使用handoverId和服务端人员身份；Mock使用conversation ID。已领取或旧版本409，AI提交必须检查最新模式。
- **IF-04：** 真实接口还需action_id、branch、项目/医生及确认快照等字段，按原OpenAPI；Mock仅演练幂等与状态，不做完整排班/时间政策校验。
- **IF-05：** 真实检索不是本Mock GET的同构替身；需要适配正式证据ID、范围、发布版本及有效性。撤回后的最终输出校验仍由A/C联合实现。
- **IF-06：** 真实浏览器使用服务端Cookie及可信身份，Mock使用独立Bearer；不能用Mock令牌访问实际系统。Mock仅租户和角色演练，不替代完整科室/对象/RLS策略。
- **IF-07：** 本项只提供目标样例，不宣称已有完整发布话术API；C与B先定字段、变量和撤回规则。
- **IF-08：** Mock为事件游标补拉，不是SSE或token流；真正流式为P1，事件schema及最终提交需要独立契约测试。

## 输入、状态和故障

- Idempotency-Key按操作人绑定；相同键同内容返回原回执，变更内容409。版本冲突需拉取最新状态再确认。
- 消息committed代表进入Mock状态库，不代表真实渠道送达或客户已读。人工模式阻止assistant消息提交。
- Mock的member_true/false/error/invalid仅用于适配语义；公开contact回执不带查询结果。
- publish中的review_passed是Mock试验开关，不是正式审核凭据；真实发布必须完整审核、评测和索引准入。
- Mock的角色/租户规则是子集，不能代替正式五岗位、科室、对象和RLS矩阵。
- 按X-Mock-Scenario选择错误，详细结果见error-scenarios.json。人工超时、断线、真实SSE及多进程竞态另做联合验收。

## 对外字段字典

| 概念 | 语义 |
|---|---|
| session_id/conversation_id | 当前系统中身份与会话映射，不能自行发明第二套映射；Mock id仅本环境有效 |
| message.id/seq | 消息唯一标识与会话内服务端顺序；时间戳不能替代顺序 |
| version/expected_version | 乐观并发校验，过期返回409 |
| tenant | 从可信身份得到，不接受客户端任意扩权 |
| receipt_id | 不透明保存回执；不能据此枚举客户是否存在 |
| record_status | existing_record/not_found仅代表院方档案查重，不代表手机归属或会员权益 |
| registered | 本系统到院意向已登记；不代表医生号源已锁定 |
| published/withdrawn | Mock资料可用状态；正式有效性还依赖发布版本和索引 |
