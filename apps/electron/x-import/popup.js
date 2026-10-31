/* This extension has no background task and never saves cookies. */
const host = 'com.usagemonitor.x_session_import';
const status = document.getElementById('status');
const check = document.getElementById('check'), button = document.getElementById('import');
let busy = false;
function begin() { if (busy) return false; busy = true; check.disabled = button.disabled = true; return true; }
function end() { busy = false; check.disabled = button.disabled = false; }
const messages = {
  bridge_ready: '本机连接正常，未读取 Cookie。', app_not_running: '请先打开 Rhetrion。',
  import_not_pending: '请先在 Rhetrion 选择“从 Chrome 导入”。', import_expired: '导入请求已取消或过期，请重新选择“从 Chrome 导入”。',
  imported: '会话已交给 Rhetrion，请在应用中检查登录结果。', import_failed: '导入未完成，原有登录保持不变。',
  verification_pending: '会话已交给 Rhetrion，正在验证 X 是否接受。请在应用中查看结果。',
  invalid_import: '会话格式不受支持，未执行导入。', no_logged_in_session: '没有找到完整的 X 登录会话。',
};
function show(response) { status.textContent = messages[response?.code] || '本机连接未完成。'; }
function failed(error) {
  const message = String(error?.message || '');
  status.textContent = /not found/i.test(message) ? 'Chrome 找不到本机桥接注册（host_not_found）。请在应用中重新配置。' : '本机连接失败，请在应用中检查桥接配置。';
}
check.addEventListener('click', async () => {
  if (!begin()) return;
  status.textContent = '正在检查本机连接…';
  try { show(await chrome.runtime.sendNativeMessage(host, { version: 1, type: 'bridge-check' })); }
  catch (error) { failed(error); } finally { end(); }
});
button.addEventListener('click', async () => {
  if (!begin()) return; let cookies = [], payload = [];
  status.textContent = '正在检查导入授权…';
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || tab.incognito || new URL(tab.url).origin !== 'https://x.com') { status.textContent = '请切换到已登录的 https://x.com 标签页。'; return; }
    const permit = await chrome.runtime.sendNativeMessage(host, { version: 1, type: 'import-preflight' });
    if (permit?.code !== 'import_ready' || !/^[a-f0-9]{64}$/.test(permit.permit)) { show(permit); return; }
    const stores = await chrome.cookies.getAllCookieStores();
    const store = stores.find(item => item.tabIds.includes(tab.id));
    if (!store) { show({ code: 'invalid_import' }); return; }
    cookies = await chrome.cookies.getAll({ domain: 'x.com', storeId: store.id });
    if (cookies.length > 256 || cookies.some(c => c.partitionKey)) { show({ code: 'invalid_import' }); return; }
    payload = cookies.map(c => {
      const value = { domain: c.domain, hostOnly: c.hostOnly, httpOnly: c.httpOnly, name: c.name, path: c.path, sameSite: c.sameSite, secure: c.secure, session: c.session, value: c.value };
      if (!c.session) value.expirationDate = c.expirationDate;
      return value;
    });
    status.textContent = '正在向 Rhetrion 传送会话…';
    const response = await chrome.runtime.sendNativeMessage(host, { version: 1, type: 'x-cookie-import', permit: permit.permit, cookies: payload });
    show(response);
  } catch (error) { failed(error); }
  finally { cookies.length = 0; payload.length = 0; end(); }
});
