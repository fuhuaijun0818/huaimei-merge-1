import assert from "node:assert/strict";
import { buildDoctorRecommendationResponse, buildPublicKnowledgeResponse, extractNamedDoctorName, getHuameiKnowledgeStatus, isDoctorRecommendationIntent, publicEvidenceFor, retrieveDoctorKnowledge, retrieveHuameiKnowledge } from "../server/huamei-knowledge.mjs";

const status = getHuameiKnowledgeStatus();
assert.equal(status.loaded, true, "华美v1知识包必须可加载");
assert.equal(status.version, "v1");
assert.equal(status.total_records, 7127);
assert.ok(status.public_retrievable_records >= 600);
assert.equal(status.restricted_assets_isolated, 2722);

const directoryHits = retrieveHuameiKnowledge("我想了解‘6月份政策’下面都有哪些项目或资料", { audience:"public", limit:5 });
assert.equal(directoryHits[0]?.item.record_id, "kb_dir_66b8d7de378ce4ed");
assert.equal(directoryHits[0]?.item.record_type, "directory_overview");

const priceHits = retrieveHuameiKnowledge("双眼皮大概怎么收费，有当前价格或活动吗？", { audience:"public", limit:8 });
assert.ok(priceHits.some((hit) => hit.item.record_type === "image_ocr"));
assert.ok(priceHits.every((hit) => hit.item.record_type !== "deidentified_operating_aggregate"));
assert.ok(priceHits.every((hit) => !/(?:前后对比|聊天记录|客户画像相关资料)/.test(hit.item.source_relative_path)));
const priceAnswer = buildPublicKnowledgeResponse("双眼皮大概怎么收费，有当前价格或活动吗？", priceHits);
assert.equal(priceAnswer.intent, "policy_verification");
assert.match(priceAnswer.message, /不能直接当作当前报价/);
assert.doesNotMatch(priceAnswer.message, /(?:5800|6800|9800|11800)/);
assert.ok(priceAnswer.evidence.every((item) => item.requires_verification === true));

const internalHits = retrieveHuameiKnowledge("客户画像汇总 女 18-24岁 累计消费0元 客户数926", { audience:"internal", limit:5 });
assert.ok(internalHits.some((hit) => hit.item.record_type === "deidentified_operating_aggregate"));
const publicHits = retrieveHuameiKnowledge("客户画像汇总 女 18-24岁 累计消费0元 客户数926", { audience:"public", limit:5 });
assert.ok(publicHits.every((hit) => hit.item.record_type !== "deidentified_operating_aggregate"));

const evidence = publicEvidenceFor(directoryHits[0], "6月份政策有哪些资料");
assert.equal(evidence.source_relative_path, "6月份政策");
assert.equal(evidence.requires_verification, true, "政策目录对外使用仍需核验");

assert.equal(extractNamedDoctorName("李健院长"), "李健");
assert.equal(extractNamedDoctorName("我想了解李健院长"), "李健");
assert.equal(extractNamedDoctorName("推荐哪个医生？"), "", "泛指问法不能被识别成医生姓名");
assert.equal(isDoctorRecommendationIntent("我想做胸部整形，推荐哪个医生？"), true);
assert.equal(isDoctorRecommendationIntent("做丰胸的医生有哪些？"), true);
const breastDoctorHits = retrieveDoctorKnowledge("我想做胸部整形，推荐哪个医生？", { limit:4 });
assert.ok(breastDoctorHits.length >= 3);
assert.ok(breastDoctorHits.every((hit) => hit.item.source_relative_path.startsWith("医生介绍/")));
assert.ok(breastDoctorHits.every((hit) => hit.item.doctor_name && !hit.item.doctor_name.includes("哪个")));
assert.ok(new Set(breastDoctorHits.map((hit) => hit.item.doctor_name)).size === breastDoctorHits.length);
const breastDoctorResponse = buildDoctorRecommendationResponse("我想做胸部整形，推荐哪个医生？", breastDoctorHits);
assert.equal(breastDoctorResponse.intent, "doctor_discovery_by_project");
assert.match(breastDoctorResponse.message, /胸部整形/);
assert.doesNotMatch(breastDoctorResponse.message, /推荐哪个院长/);
assert.ok(breastDoctorResponse.evidence.every((item) => item.source_relative_path.startsWith("医生介绍/")));
assert.equal(breastDoctorResponse.evidence.length, breastDoctorResponse.doctor_candidates.length);

console.log("✓ 华美v1知识包加载、公共/内部边界与证据引用通过");
console.log("✓ 价格政策不直接当作当前报价，受限客户素材保持隔离");
