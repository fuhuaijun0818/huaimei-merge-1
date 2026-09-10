# V2 开发启动与联调入口

先阅读[开发启动说明](docs/onboarding/00_开始开发.md)。V2继承V1历史，新增独立Mock、测试数据与开发说明。新交付从V2标签创建分支。

# 华美三人协作开发基线

共同基线：`team-baseline-20260910-v2`。本仓库包含源工作目录的最新源码快照，使用独立Git历史；不含生产凭据、客户运行数据和历史交付证据。它是并行开发起点，不是生产验收证书。

请先读 [共同交付规范](handoff/共同交付规范.md)，再读 [A](handoff/A_交付规范.md)、[B](handoff/B_交付规范.md)、[C](handoff/C_交付规范.md) 中自己的规范。文件范围见 [ownership.json](handoff/ownership.json)。旧文档涉及OTP、旧架构或历史容量的描述，不覆盖本次规范及实际代码行为。

```sh
npm ci
npm --prefix apps/acquisition-advisor ci
npm run team:init
npm run team:build
npm run team:verify
npm run dev
```

前台 http://127.0.0.1:4173/advisor/ ，后台 http://127.0.0.1:4173/login 。

team:init生成本机独立测试密码，不复制负责人账号。默认不访问模型及院方接口；自行获得开发配置后再启用对应能力。知识包是924条公开记录的开发子集；需要完整原始知识/真实数据库的专项测试另行提供环境。首轮不要把未启用的LangGraph/GraphRAG描述为已上线引擎。

## 交付

提交代码和report后运行 `npm run team:deliver -- --role A --id dialogue-001 --report handoff/report-A-dialogue-001.json`。交回输出目录的全部文件。负责人使用 `team:inspect` 检查，不会自动合并或执行提交代码。
