import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
const testCases=[
 ['remote denied','postgres://db.example/huamei_team_dev',false],
 ['normal business database denied','postgres://localhost/huamei',false],
 ['query override denied','postgres://localhost/huamei_team_dev?host=db.example',false],
 ['local development preview','postgres://localhost/huamei_team_dev',true]
];
for(const [name,url,ok] of testCases){const r=spawnSync(process.execPath,['devkit/seed-postgres.mjs'],{encoding:'utf8',env:{PATH:process.env.PATH,HUAMEI_TEAM_SEED_DATABASE_URL:url}});assert.equal(r.status===0,ok,name);if(ok)assert.equal(JSON.parse(r.stdout).dry_run,true);}
const prod=spawnSync(process.execPath,['devkit/seed-postgres.mjs'],{env:{PATH:process.env.PATH,NODE_ENV:'production',HUAMEI_TEAM_SEED_DATABASE_URL:'postgres://localhost/huamei_team_dev'}});assert.notEqual(prod.status,0);console.log('PASS 5 database seed guards/preview; no database connection or apply');
