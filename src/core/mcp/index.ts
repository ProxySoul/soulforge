import { MCPManager } from "./manager.js";

let _instance: MCPManager | null = null;

export function getMCPManager(): MCPManager {
  if (!_instance) _instance = new MCPManager();
  return _instance;
}

export function disposeMCPManager(): Promise<void> {
  if (!_instance) return Promise.resolve();
  const inst = _instance;
  _instance = null;
  return inst.dispose();
}

export { MCPManager } from "./manager.js";
