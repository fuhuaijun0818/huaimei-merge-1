import {seed} from './fixtures.mjs';
if(process.argv.some(a=>!['--reset'].includes(a)&&process.argv.indexOf(a)>1))throw new Error('仅支持--reset；只能操作仓库.team-dev开发数据');
const result=seed(undefined,process.argv.includes('--reset'));
console.log(JSON.stringify({...result,note:'12个随机账号仅供开发Mock。重置前先停止Mock；不修改真实应用或数据库。'},null,2));
