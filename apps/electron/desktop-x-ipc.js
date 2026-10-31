import { validateXDetailQuery, validateXQuery, validateXSettings, X_SESSION_ERRORS } from './desktop-x-contract.js';

export const X_IPC_CHANNEL = 'usagemonitor:x-reader:v1';
const EMPTY = new Set(['getXStatus', 'cancelXLogin', 'getXSettings', 'logoutX', 'clearXCache', 'configureXImport', 'openXImportFolder']);
const ACTIONS = new Set([...EMPTY, 'refreshX', 'listXPosts', 'getXPost', 'beginXLogin', 'setXSettings']);
function exact(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function rejected(code) { return Object.assign(new Error('X reader request rejected'), { code }); }
export function validateXDesktopRequest(request) {
  if (!exact(request, ['action', 'args']) || !ACTIONS.has(request.action)) throw rejected('x_invalid_request');
  const { action, args } = request;
  if (EMPTY.has(action)) { if (!exact(args, [])) throw rejected('x_invalid_request'); }
  else if (action === 'listXPosts') {
    const keys = Object.hasOwn(args ?? {}, 'cursor') ? ['tab', 'cursor'] : ['tab'];
    if (!exact(args, keys)) throw rejected('x_invalid_request');
    validateXQuery(args);
  } else if (action === 'refreshX') {
    if (!exact(args, ['tab'])) throw rejected('x_invalid_request'); validateXQuery(args);
  } else if (action === 'getXPost') {
    if (!exact(args, Object.hasOwn(args ?? {}, 'cursor') ? ['id', 'cursor'] : Object.hasOwn(args ?? {}, 'force') ? ['id', 'force'] : ['id'])) throw rejected('x_invalid_request'); validateXDetailQuery(args);
  } else if (action === 'beginXLogin') {
    if (!exact(args, ['method']) || !['web', 'session'].includes(args.method)) throw rejected('x_invalid_request');
  } else {
    if (!exact(args, ['value'])) throw rejected('x_invalid_request'); validateXSettings(args.value);
  }
  return { action, args };
}
export function installDesktopXIpc({ ipcMain, service, importBridge, authorize }) {
  if (typeof authorize !== 'function') throw new TypeError('X IPC authorization required');
  const handlers = {
    getXStatus: () => service.getStatus(),
    listXPosts: args => service.listPosts(args),
    getXPost: args => service.getPost(args),
    refreshX: args => service.refresh({ tab: args.tab, reason: 'manual' }),
    beginXLogin: args => service.beginLogin(args),
    cancelXLogin: () => service.cancelLogin(),
    getXSettings: () => service.getSettings(),
    setXSettings: args => service.setSettings(args.value),
    logoutX: () => service.logout(),
    clearXCache: () => service.clearCache(),
    openXImportFolder: () => importBridge.reveal(),
    configureXImport: async () => {
      const configured = await importBridge.configure();
      const status = await service.getStatus();
      // Setup replaces the native broker and cancels its previous permit.
      // Re-arm only the owner's already-selected Session login operation.
      if (configured.configured === true && status.auth === 'authorizing' && status.loginMethod === 'session') {
        await service.beginLogin({ method: 'session' });
      }
      return configured;
    },
  };
  const handler = async (event, input) => {
    // Hash routes are presentation. Authorization belongs to the exact local
    // main WebContents, top frame and validated loopback document.
    if (authorize(event) !== true) throw rejected('x_untrusted_context');
    let request;
    try { request = validateXDesktopRequest(input); } catch { throw rejected('x_invalid_request'); }
    try { return await handlers[request.action](request.args); }
    catch (error) {
      // Electron drops custom Error fields across invoke. Preserve only fixed,
      // allowlisted failure categories in the message, never upstream context.
      if (X_SESSION_ERRORS.includes(error?.code) || error?.code === 'storage_unavailable') {
        throw Object.assign(new Error(error.code), { code: error.code });
      }
      throw rejected('x_operation_failed');
    }
  };
  ipcMain.handle(X_IPC_CHANNEL, handler);
  return { handler, dispose: () => ipcMain.removeHandler?.(X_IPC_CHANNEL) };
}
