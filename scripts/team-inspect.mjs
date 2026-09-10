import {secretFindings} from './team-secret-scan.mjs';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {resolve,dirname,join} from 'node:path';
import {createHash} from 'node:crypto';
const git=(...args)=>execFileSync('git',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const hash=b=>createHash('sha256').update(b).digest('hex');
const fail=m=>{throw new Error(m);};
const path=resolve(process.argv[2]||'');const dir=dirname(path),m=JSON.parse(readFileSync(path));
const config=JSON.parse(readFileSync('BASELINE.json'));const base=git('rev-parse',`${config.tag}^{commit}`);
if(m.schema!=='huamei.team.delivery.v1'||m.baseline_id!==config.id||m.baseline_commit!==base)fail('交付基线不匹配。');
if(!['A','B','C'].includes(m.role)||!/^[a-z0-9][a-z0-9-]{2,60}$/.test(m.task_id)||!new RegExp(`^feature/${m.role}/[A-Za-z0-9/_-]+$`).test(m.branch)||!/^[a-f0-9]{40}$/.test(m.head_commit))fail('交付标识或引用不合法。');
if(m.bundle_file!=='code.bundle'||m.report_file!=='report.json')fail('不接受包外文件路径。');
const bundle=join(dir,m.bundle_file),reportFile=join(dir,m.report_file);
if(hash(readFileSync(bundle))!==m.bundle_sha256||hash(readFileSync(reportFile))!==m.report_sha256)fail('文件哈希不匹配。');
const report=JSON.parse(readFileSync(reportFile));if(report.role!==m.role||report.task_id!==m.task_id)fail('报告与清单身份不匹配。');
git('bundle','verify',bundle);
const refs=git('bundle','list-heads',bundle).split('\n');if(!refs.includes(`${m.head_commit} refs/heads/${m.branch}`))fail('bundle中的分支/提交不匹配。');
const incoming=`refs/heads/incoming/${m.role}/${m.task_id}`;
try{git('rev-parse','--verify',incoming);fail('接收引用已存在，请检查之前的交付，禁止覆盖。');}catch(e){if(e.message==='接收引用已存在，请检查之前的交付，禁止覆盖。')throw e;}
git('-c','core.hooksPath=/dev/null','fetch','--no-tags',bundle,`refs/heads/${m.branch}:${incoming}`);
git('merge-base','--is-ancestor',base,m.head_commit);
const allowed=JSON.parse(git('show',`${base}:handoff/secret-fixture-hashes.json`)).sha256;
for(const path of git('ls-tree','-r','--name-only',m.head_commit).split('\n')){if(/(^|\/)(?:node_modules|\.local-data|dist)(\/|$)/.test(path)||/(^|\/)\.env(?:\..+)?$/.test(path)&&!path.endsWith('.env.example')||/\.(?:bundle|sqlite|pem|key)$/.test(path))fail('包含禁止交付文件：'+path);const blob=execFileSync('git',['show',`${m.head_commit}:${path}`],{maxBuffer:64*1024*1024});if(blob.includes(0))continue;const f=secretFindings(blob.toString('utf8'),allowed);if(f.private_key||f.new_credentials)fail('发现新的疑似凭据：'+path);}
const actual=git('diff','--no-renames','--name-only',base,m.head_commit).split('\n').filter(Boolean).sort();
if(JSON.stringify(actual)!==JSON.stringify(m.files.map(f=>f.path).sort()))fail('变更文件清单不匹配；已导入incoming供审查，未合并。');
for(const f of m.files){let content;try{content=execFileSync('git',['show',`${m.head_commit}:${f.path}`],{stdio:['ignore','pipe','ignore'],maxBuffer:64*1024*1024});}catch{if(f.status!=='deleted'||f.sha256!==null)fail('删除记录不匹配');continue;}if(f.status!=='present'||hash(content)!==f.sha256)fail('文件内容与清单不匹配：'+f.path);}
console.log(JSON.stringify({verified:true,imported_reference:incoming,merged:false,code_executed:false,role:m.role,task_id:m.task_id,changed_files:m.files.length,tests_are_self_reported:true},null,2));
