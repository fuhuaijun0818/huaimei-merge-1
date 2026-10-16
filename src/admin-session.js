const enabled=Boolean(window.__HUAMEI_MANAGEMENT_RUNTIME__?.browser_session_auth);
const channel=enabled&&typeof BroadcastChannel!=='undefined'?new BroadcastChannel('huamei-admin-session'):null;
let leaving=false;
export function expireAdminSession(reason='expired') {
  if(!enabled||leaving)return;leaving=true;
  // Reply drafts can contain customer-facing content.  Tell the application
  // to discard them before this tab is redirected to the login page.  A
  // custom event keeps this session module independent of the composer.
  window.dispatchEvent(new Event('huamei:management-session-ending'));
  document.querySelector('#app')?.replaceChildren();document.querySelector('#modal-root')?.replaceChildren();
  location.replace('/login?reason='+encodeURIComponent(reason)+location.hash);
}
export async function logoutAdminSession() {
  if(!enabled||leaving)return;
  const response=await fetch('/auth/logout',{method:'POST',credentials:'same-origin',cache:'no-store'});
  if(!response.ok)throw new Error('退出失败，请检查网络后重试');
  channel?.postMessage('logout');expireAdminSession('logged-out');
}
async function checkSession(){if(!enabled||leaving||document.hidden)return;try{const response=await fetch('/auth/session',{credentials:'same-origin',cache:'no-store'});if(response.status===401)expireAdminSession();}catch{/* A network outage does not prove the session was revoked. */}}
if(enabled){channel?.addEventListener('message',event=>{if(event.data==='logout')expireAdminSession('logged-out');});window.addEventListener('focus',checkSession);window.addEventListener('pageshow',event=>{if(event.persisted){location.reload();return;}checkSession();});document.addEventListener('visibilitychange',checkSession);setInterval(checkSession,60_000);window.addEventListener('pagehide',()=>{document.querySelector('#app')?.replaceChildren();});}
