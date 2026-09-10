import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const values = new Map();
globalThis.localStorage = {
  getItem:(key) => values.get(key) || null,
  setItem:(key, value) => values.set(key, String(value)),
  removeItem:(key) => values.delete(key)
};

const { store } = await import(`../src/store.js?journey-canvas=${Date.now()}`);
const journey = store.addJourney({
  name:"画布测试旅程",
  stage:"售前",
  owner:"测试运营",
  status:"运行中",
  version:"v1.0",
  nodes:["新咨询", "授权检查", "完成"]
});
assert.ok(journey, "应能由运营人员创建可运行的旅程记录");
const journeyId = journey.id;
const runningNodes = [...journey.nodes];
const canvas = {
  nodes:[
    { id:"start", type:"trigger", name:"新咨询进入", condition:"已建立咨询", successAction:"进入合规检查" },
    { id:"guard", type:"compliance", name:"授权检查", condition:"服务授权有效", successAction:"放行", timeoutAction:"创建人工任务", branchYes:"通过", branchNo:"拦截" },
    { id:"end", type:"end", name:"完成", condition:"流程结束", successAction:"写入客户360" }
  ]
};

const saved = store.saveJourneyCanvas(journeyId, canvas);
assert.equal(saved.status, "运行中");
const stagedJourney = store.state.journeys.find((item) => item.id === journeyId);
assert.deepEqual(stagedJourney.nodes, runningNodes, "运行中旅程保存画布时不能覆盖正在服务客户的版本");
assert.equal(stagedJourney.draftCanvas.nodes.length, 3);
assert.match(stagedJourney.draftVersion, /-draft$/);

store.publishJourney(journeyId);
const publishedJourney = store.state.journeys.find((item) => item.id === journeyId);
assert.deepEqual(publishedJourney.nodes, ["新咨询进入", "授权检查", "完成"], "发布时应将待发布画布提升为当前版本");
assert.equal(publishedJourney.draftCanvas, undefined);

const [app, styles] = await Promise.all([
  readFile(new URL("../src/app.js", import.meta.url), "utf8"),
  readFile(new URL("../styles.css", import.meta.url), "utf8")
]);
assert.match(app, /function journeyCanvasPage/, "旅程详情应由可操作画布承载");
assert.match(app, /case "select-journey-node"/, "画布必须支持节点选择");
assert.match(app, /case "add-node"/, "画布必须支持从步骤库新增节点");
assert.match(app, /case "save-journey"/, "画布必须支持保存待发布版本");
assert.match(styles, /\.journey-canvas-editor/, "画布需要独立布局样式");

console.log("✓ 旅程画布的草稿隔离、发布提升和交互入口已校验");
