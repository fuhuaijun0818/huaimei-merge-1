import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {roleCatalogEntry} from '../src/role-catalog.js';
const source=readFileSync(new URL('../src/app.js',import.meta.url),'utf8');
const start=source.indexOf('function currentPage() {');
const end=source.indexOf('\n}',start)+2;
assert.ok(start>=0&&end>start);
for(const [role,route,expected] of [
 ['系统管理员','workbench','home'],['系统管理员','integrations','integrations'],['系统管理员','administration','accounts'],
 ['内容专员','workbench','home'],['内容专员','knowledge','knowledge'],['发布与索引管理员','knowledge','knowledge'],['质量与运营人员','workbench','home']
]){
 const sandbox={ui:{managementIdentity:{role}},roleCatalogEntry,routeInfo:()=>({route}),managedAccountsPage:()=> 'accounts',systemIntegrationsPage:()=> 'integrations',roleWorkbenchPage:()=> 'home',productionKnowledgeGovernancePage:()=> 'knowledge'};
 assert.equal(vm.runInNewContext(source.slice(start,end)+'\ncurrentPage()',sandbox),expected,role+' '+route);
}
console.log('PASS: actual currentPage dispatch gives distinct administrator destinations and role workbenches');
