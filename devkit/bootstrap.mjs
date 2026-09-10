import {spawnSync} from 'node:child_process';
const npm=process.platform==='win32'?'npm.cmd':'npm';
for(const args of [['ci'],['--prefix','apps/acquisition-advisor','ci'],['run','team:build'],['run','team:seed'],['run','team:doctor']]){
 const r=spawnSync(npm,args,{stdio:'inherit'});if(r.status!==0)process.exit(r.status||1);
}
console.log('开发依赖、前台构建与Mock账号已就绪。运行team:test:mock或team:test:http核验；实际应用使用team:init后npm run dev。');
