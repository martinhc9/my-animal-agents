const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  openAgent: (agentId) => ipcRenderer.invoke('open-agent', agentId),
  closeChat: () => ipcRenderer.invoke('close-chat'),
  chat: (agent, messages) => ipcRenderer.invoke('chat', { agent, messages }),
  openSettings: () => ipcRenderer.invoke('open-settings'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  loadHistory: (agentId) => ipcRenderer.invoke('load-history', agentId),
  saveHistory: (agentId, messages) => ipcRenderer.invoke('save-history', { agentId, messages }),
  setMouseThrough: (through) => ipcRenderer.invoke('set-mouse-through', through),
  moveBarBy: (dx, dy) => ipcRenderer.invoke('move-bar-by', dx, dy),
  resetBarPosition: () => ipcRenderer.invoke('reset-bar-position'),
  // 다마고치
  getAffinity: (agentId) => ipcRenderer.invoke('get-affinity', agentId),
  getAllAffinities: () => ipcRenderer.invoke('get-all-affinities'),
  // 커스터마이징
  getAgentsOrder: () => ipcRenderer.invoke('get-agents-order'),
  setAgentsOrder: (order) => ipcRenderer.invoke('set-agents-order', order),
  getAgentCustom: (agentId) => ipcRenderer.invoke('get-agent-custom', agentId),
  setAgentCustom: (data) => ipcRenderer.invoke('set-agent-custom', data),
  resetAgentCustom: (agentId) => ipcRenderer.invoke('reset-agent-custom', agentId),
  pickAgentImage: (agentId) => ipcRenderer.invoke('pick-agent-image', agentId),
  getDefaultRole: (agentId) => ipcRenderer.invoke('get-default-role', agentId),
  // 플로팅 바 방향
  onOrientationChange: (callback) => ipcRenderer.on('orientation-change', (_, o) => callback(o)),
  // Ollama 상태
  getLlmStatus: () => ipcRenderer.invoke('get-llm-status'),
  getPendingChat: (agentId) => ipcRenderer.invoke('get-pending-chat', agentId),
  onChatResponse: (callback) => ipcRenderer.on('chat-response', (_, data) => callback(data)),
});
