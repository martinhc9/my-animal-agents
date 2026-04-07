const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, screen, shell, protocol, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const Store = require('electron-store');

const store = new Store();
let tray = null;
let floatBar = null;
let chatWindow = null;

// RSS 뉴스 캐시
const newsCache = { panda: null, capybara: null };

// Ollama 설정
const OLLAMA_BASE = 'http://127.0.0.1:11434';
const DEFAULT_MODEL = 'qwen2.5:7b';
let ollamaReady = false;

// --- 다마고치 시스템 ---
const LEVEL_THRESHOLDS = [0, 10, 25, 50, 100];

function getAffinity(agentId) {
  return store.get(`affinity-${agentId}`, { xp: 0, level: 1, streak: 0, lastUsed: null });
}

function addXP(agentId, amount = 1) {
  const data = getAffinity(agentId);
  const today = new Date().toISOString().split('T')[0];

  if (data.lastUsed) {
    const diffDays = Math.floor((new Date(today) - new Date(data.lastUsed)) / (1000 * 60 * 60 * 24));
    if (diffDays === 1) data.streak += 1;
    else if (diffDays > 1) data.streak = 1;
  } else {
    data.streak = 1;
  }

  data.lastUsed = today;
  data.xp += amount;

  let newLevel = 1;
  for (let i = LEVEL_THRESHOLDS.length - 1; i >= 0; i--) {
    if (data.xp >= LEVEL_THRESHOLDS[i]) { newLevel = i + 1; break; }
  }
  data.level = newLevel;

  store.set(`affinity-${agentId}`, data);
  return data;
}

function getLevelTone(level) {
  const tones = {
    1: '처음 만난 사이. 존댓말을 쓰고, 조금 어색하지만 친절하게.',
    2: '몇 번 만난 사이. 여전히 존댓말이지만 조금 편안해진 톤.',
    3: '꽤 친한 사이. 반말을 섞어 써도 되고, 농담도 가끔.',
    4: '절친한 사이. 편하게 반말, 장난도 치고, 속마음도 이야기.',
    5: '가족 같은 사이. 아주 친밀하고 따뜻한 톤. 별명도 부를 수 있어.',
  };
  return tones[level] || tones[1];
}

// --- Ollama API ---
async function ollamaChat(systemPrompt, messages) {
  const body = {
    model: DEFAULT_MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      ...messages,
    ],
    stream: false,
    options: {
      temperature: 0.7,
      top_p: 0.9,
      num_predict: 1024,
    },
  };

  const res = await fetch(`${OLLAMA_BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Ollama 에러 (${res.status}): ${text}`);
  }

  const data = await res.json();
  return data.message.content;
}

async function checkOllama() {
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/tags`);
    if (res.ok) {
      const data = await res.json();
      const hasModel = data.models?.some(m => m.name === DEFAULT_MODEL || m.name.startsWith(DEFAULT_MODEL.split(':')[0]));
      ollamaReady = hasModel;
      console.log(`[Ollama] 연결됨, 모델 ${DEFAULT_MODEL}: ${hasModel ? '있음' : '없음'}`);
      return hasModel;
    }
  } catch {
    console.log('[Ollama] 연결 실패 — ollama가 실행 중인지 확인하세요');
  }
  ollamaReady = false;
  return false;
}

// --- 윈도우 생성 ---
function createFloatBar() {
  const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize;

  const defaultBounds = {
    width: 420, height: 100,
    x: Math.round(screenWidth / 2 - 210),
    y: screenHeight - 100,
  };

  let bounds = defaultBounds;
  const savedBounds = store.get('floatbar-bounds', null);
  if (savedBounds && savedBounds.x >= 0 && savedBounds.y >= 0
      && savedBounds.x < screenWidth && savedBounds.y < screenHeight) {
    bounds = savedBounds;
  } else {
    store.delete('floatbar-bounds');
  }

  floatBar = new BrowserWindow({
    ...bounds,
    frame: false,
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    transparent: true,
    hasShadow: false,
    minWidth: 200,
    minHeight: 80,
    maxHeight: 120,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  floatBar.loadFile(path.join(__dirname, 'renderer', 'float-bar.html'));
  floatBar.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  floatBar.setIgnoreMouseEvents(true, { forward: true });

  const saveBounds = () => {
    if (floatBar && !floatBar.isDestroyed()) {
      store.set('floatbar-bounds', floatBar.getBounds());
    }
  };
  floatBar.on('moved', saveBounds);
  floatBar.on('resized', saveBounds);

  floatBar.webContents.on('did-finish-load', () => {
    floatBar.webContents.executeJavaScript(`
      document.querySelector('.bar').addEventListener('mouseenter', () => {
        window.api.setMouseThrough(false);
      });
      document.querySelector('.trigger-zone').addEventListener('mouseenter', () => {
        window.api.setMouseThrough(true);
      });
    `);
  });
}

function createTray() {
  const iconPath = path.join(__dirname, 'assets', 'tray-icon.png');
  let trayImage;
  try {
    trayImage = nativeImage.createFromPath(iconPath).resize({ width: 18, height: 18 });
  } catch {
    trayImage = nativeImage.createEmpty();
  }
  tray = new Tray(trayImage);
  tray.setToolTip('My Agents');
  if (trayImage.isEmpty()) tray.setTitle('🐾');

  const trayMenu = Menu.buildFromTemplate([
    { label: '설정', click: () => createChatWindow('settings') },
    { label: '원위치 복귀', click: () => {
      const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
      const bounds = { width: 420, height: 100, x: Math.round(sw / 2 - 210), y: sh - 100 };
      store.delete('floatbar-bounds');
      store.delete('floatbar-orientation');
      if (floatBar && !floatBar.isDestroyed()) {
        floatBar.setMinimumSize(200, 80);
        floatBar.setMaximumSize(9999, 120);
        floatBar.setBounds(bounds);
        floatBar.webContents.send('orientation-change', 'horizontal');
      }
    }},
    { type: 'separator' },
    { label: '종료', click: () => { app.quit(); } },
  ]);
  tray.setContextMenu(trayMenu);
}

function createChatWindow(agentId) {
  if (chatWindow) {
    chatWindow.close();
    chatWindow = null;
  }

  const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize;
  const barBounds = floatBar && !floatBar.isDestroyed()
    ? floatBar.getBounds()
    : { x: Math.round(screenWidth / 2 - 210), y: screenHeight - 100, width: 420 };
  const chatWidth = 400;
  const chatHeight = 520;
  const chatX = Math.max(0, Math.min(screenWidth - chatWidth, Math.round(barBounds.x + barBounds.width / 2 - chatWidth / 2)));
  const chatY = Math.max(10, barBounds.y - chatHeight - 10);

  chatWindow = new BrowserWindow({
    width: chatWidth,
    height: chatHeight,
    x: chatX,
    y: chatY,
    frame: false,
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    transparent: true,
    hasShadow: true,
    vibrancy: 'under-window',
    visualEffectState: 'active',
    minWidth: 320,
    minHeight: 400,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  chatWindow.loadFile(path.join(__dirname, 'renderer', 'chat.html'), {
    query: { agent: agentId },
  });

  if (agentId !== 'settings') {
    chatWindow.on('blur', () => {
      if (chatWindow && !chatWindow.isDestroyed()) {
        chatWindow.close();
      }
    });
  }

  chatWindow.on('closed', () => {
    chatWindow = null;
    newsCache.panda = null;
    newsCache.capybara = null;
  });
}

// --- App 설정 ---
app.dock?.hide();

app.whenReady().then(async () => {
  createTray();
  createFloatBar();
  await checkOllama();
});

// --- IPC handlers ---
ipcMain.handle('open-agent', (_, agentId) => createChatWindow(agentId));
ipcMain.handle('open-settings', () => createChatWindow('settings'));

// 캐릭터 커스터마이징
const DEFAULT_AGENTS_ORDER = ['panda', 'monkey', 'cat', 'capybara', 'nureong'];

ipcMain.handle('get-agents-order', () => store.get('agents-order', DEFAULT_AGENTS_ORDER));
ipcMain.handle('set-agents-order', (_, order) => { store.set('agents-order', order); return true; });

ipcMain.handle('get-agent-custom', (_, agentId) => store.get(`custom-${agentId}`, null));
ipcMain.handle('set-agent-custom', (_, { agentId, name, role }) => {
  store.set(`custom-${agentId}`, { name, role });
  return true;
});
ipcMain.handle('reset-agent-custom', (_, agentId) => {
  store.delete(`custom-${agentId}`);
  return true;
});

// 기본 역할 프롬프트
const DEFAULT_ROLE_PROMPTS = {
  panda: 'HR 뉴스 전문가. 오늘의 실제 HR 관련 뉴스를 검색해서 요약/정리해줘. 중요한 3~5개를 골라서 제목, 핵심 2~3줄, 인사이트 1줄, 링크를 제공해.',
  monkey: '멘탈 케어 친구. 사용자의 기분을 물어보고, 위로/격려/용기를 줘. 먼저 공감하고 경청해. 힘든 이야기에는 위로를, 좋은 이야기에는 함께 기뻐해줘.',
  cat: '음악 큐레이터. 사용자의 기분/상황에 맞는 플레이리스트를 큐레이션해줘. 5~7곡 구성, 유튜브 검색 링크 포함. 한국 노래와 외국 노래를 적절히 섞어줘.',
  capybara: '트렌드 큐레이터. 오늘 가장 핫한 이슈, 트렌드, 화제를 정리해줘. 핫한 3~5개를 골라 소개. 각각 2~3줄 요약, 왜 핫한지, 링크 제공.',
  nureong: '아재개그 장인. 말장난, 동음이의어 유머, 끝말잇기 드립 등 전형적인 아재개그를 들려줘. 한 번에 1~2개씩. "...멍." 을 가끔 넣어. 19금/차별적 유머 절대 금지.',
};

ipcMain.handle('get-default-role', (_, agentId) => DEFAULT_ROLE_PROMPTS[agentId] || '');

// 이미지 변경
ipcMain.handle('pick-agent-image', async (_, agentId) => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
  });
  if (result.canceled || !result.filePaths[0]) return null;

  const srcPath = result.filePaths[0];
  for (let lv = 1; lv <= 5; lv++) {
    fs.copyFileSync(srcPath, path.join(__dirname, 'assets', `${agentId}-lv${lv}.png`));
  }
  if (floatBar && !floatBar.isDestroyed()) floatBar.webContents.reload();
  return { success: true };
});

// Chat history
ipcMain.handle('load-history', (_, agentId) => {
  const today = new Date().toISOString().split('T')[0];
  return store.get(`history-${agentId}-${today}`, null);
});

ipcMain.handle('save-history', (_, { agentId, messages }) => {
  const today = new Date().toISOString().split('T')[0];
  store.set(`history-${agentId}-${today}`, messages);
});

ipcMain.handle('open-external', async (_, url) => { await shell.openExternal(url); });

ipcMain.handle('set-mouse-through', (_, through) => {
  if (floatBar && !floatBar.isDestroyed()) floatBar.setIgnoreMouseEvents(through, { forward: true });
});

ipcMain.handle('move-bar-by', (_, dx, dy) => {
  if (floatBar && !floatBar.isDestroyed()) {
    const [x, y] = floatBar.getPosition();
    const newX = x + dx;
    const newY = y + dy;
    floatBar.setPosition(newX, newY);

    // 화면 가장자리 감지 → 수직/수평 전환
    const { width: sw } = screen.getPrimaryDisplay().workAreaSize;
    const bounds = floatBar.getBounds();
    const EDGE = 60;
    let orientation = 'horizontal';
    if (newX <= EDGE) orientation = 'vertical-left';
    else if (newX + bounds.width >= sw - EDGE) orientation = 'vertical-right';

    // 방향에 따라 윈도우 크기 조정
    const prevOrientation = store.get('floatbar-orientation', 'horizontal');
    if (orientation !== prevOrientation) {
      if (orientation === 'horizontal') {
        floatBar.setMinimumSize(200, 80);
        floatBar.setMaximumSize(9999, 120);
        floatBar.setSize(420, 100);
      } else {
        floatBar.setMinimumSize(80, 200);
        floatBar.setMaximumSize(120, 9999);
        floatBar.setSize(100, 420);
      }
      store.set('floatbar-orientation', orientation);
      floatBar.webContents.send('orientation-change', orientation);
    }

    store.set('floatbar-bounds', floatBar.getBounds());
  }
});

ipcMain.handle('reset-bar-position', () => {
  const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize;
  const bounds = { width: 420, height: 100, x: Math.round(screenWidth / 2 - 210), y: screenHeight - 100 };
  store.delete('floatbar-bounds');
  if (floatBar && !floatBar.isDestroyed()) floatBar.setBounds(bounds);
  return true;
});

ipcMain.handle('close-chat', () => {
  if (chatWindow) { chatWindow.close(); chatWindow = null; }
});

// 다마고치 IPC
ipcMain.handle('get-affinity', (_, agentId) => getAffinity(agentId));
ipcMain.handle('get-all-affinities', () => {
  const agents = store.get('agents-order', DEFAULT_AGENTS_ORDER);
  const result = {};
  for (const id of agents) result[id] = getAffinity(id);
  return result;
});

// Ollama 상태
ipcMain.handle('get-llm-status', async () => {
  if (!ollamaReady) await checkOllama();
  return { ready: ollamaReady, model: DEFAULT_MODEL };
});

// --- RSS 뉴스 ---
async function fetchHRNews() {
  try {
    const queries = ['HR+인사+채용+트렌드', '노동시장+채용+2026', '조직문화+인사관리'];
    const query = queries[Math.floor(Math.random() * queries.length)];
    const res = await fetch(`https://news.google.com/rss/search?q=${query}&hl=ko&gl=KR&ceid=KR:ko`);
    const xml = await res.text();
    const items = [];
    const re = /<item>([\s\S]*?)<\/item>/g;
    let m;
    while ((m = re.exec(xml)) !== null && items.length < 8) {
      const x = m[1];
      const title = (x.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '';
      const link = (x.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || '';
      const source = (x.match(/<source[^>]*>([\s\S]*?)<\/source>/) || [])[1] || '';
      if (title) items.push({ title: title.replace(/<!\[CDATA\[|\]\]>/g, '').trim(), link, source });
    }
    return items;
  } catch { return []; }
}

async function fetchTrendNews() {
  try {
    const queries = ['트렌드+화제+2026', '핫이슈+화제', 'MZ세대+트렌드+핫'];
    const query = queries[Math.floor(Math.random() * queries.length)];
    const res = await fetch(`https://news.google.com/rss/search?q=${query}&hl=ko&gl=KR&ceid=KR:ko`);
    const xml = await res.text();
    const items = [];
    const re = /<item>([\s\S]*?)<\/item>/g;
    let m;
    while ((m = re.exec(xml)) !== null && items.length < 8) {
      const x = m[1];
      const title = (x.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '';
      const link = (x.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || '';
      const source = (x.match(/<source[^>]*>([\s\S]*?)<\/source>/) || [])[1] || '';
      if (title) items.push({ title: title.replace(/<!\[CDATA\[|\]\]>/g, '').trim(), link, source });
    }
    return items;
  } catch { return []; }
}

// --- System prompt builder ---
async function buildSystemPrompt(agent) {
  const today = new Date().toLocaleDateString('ko-KR', {
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'long'
  });

  const affinity = getAffinity(agent);
  const tone = getLevelTone(affinity.level);
  const ctx = `\n[친밀도 Lv.${affinity.level} | 연속 ${affinity.streak}일]\n말투: ${tone}\n`;

  // 커스텀 역할이 있으면 우선 사용
  const custom = store.get(`custom-${agent}`, null);
  if (custom && custom.role) {
    const name = custom.name || agent;
    return `너는 "${name}"이라는 이름의 AI 에이전트야.\n역할: ${custom.role}\n오늘: ${today}${ctx}\n반드시 한국어로만 답변해.`;
  }

  const prompts = {
    panda: `PANDA_PLACEHOLDER`,
    monkey: `너는 "펀치"라는 이름의 원숭이 멘탈 케어 친구야.\n역할: 사용자의 기분을 물어보고, 위로/격려/용기를 줘.\n오늘: ${today}${ctx}\n한국어로 답변해.`,
    cat: `너는 "야옹이"라는 이름의 고양이 음악 큐레이터야.\n역할: 사용자의 기분에 맞는 플레이리스트를 큐레이션. 유튜브 검색 링크 포함.\n오늘: ${today}${ctx}\n한국어로 답변해.`,
    capybara: `CAPYBARA_PLACEHOLDER`,
    nureong: `너는 "누렁이"라는 이름의 강아지 아재개그 장인이야. "...멍." 을 가끔 넣어.\n역할: 아재개그 전문! 말장난, 동음이의어 유머. 한 번에 1~2개씩.\n오늘: ${today}${ctx}\n19금 금지. 한국어로 답변해.`,
  };

  if (agent === 'panda') {
    if (!newsCache.panda) newsCache.panda = await fetchHRNews();
    const news = newsCache.panda;
    const newsText = news.length > 0
      ? news.map((n, i) => `${i+1}. [${n.source}] ${n.title}\n   ${n.link}`).join('\n')
      : '(뉴스를 가져오지 못했어요.)';
    prompts.panda = `너는 "팬더"라는 이름의 판다 HR 뉴스 전문가야.\n역할: 오늘의 HR 뉴스를 요약/정리.\n오늘: ${today}${ctx}\n📰 오늘의 HR 뉴스:\n${newsText}\n한국어로 답변해.`;
  }

  if (agent === 'capybara') {
    if (!newsCache.capybara) newsCache.capybara = await fetchTrendNews();
    const trendNews = newsCache.capybara;
    const trendText = trendNews.length > 0
      ? trendNews.map((n, i) => `${i+1}. [${n.source}] ${n.title}\n   ${n.link}`).join('\n')
      : '(트렌드를 가져오지 못했어요.)';
    prompts.capybara = `너는 "카피바라"라는 이름의 트렌드 큐레이터야.\n역할: 오늘 가장 핫한 이슈를 정리.\n오늘: ${today}${ctx}\n🔥 오늘의 트렌드:\n${trendText}\n한국어로 답변해.`;
  }

  return prompts[agent] || prompts.panda;
}

// --- Chat handler (Ollama) — 비동기 처리, 창 닫혀도 완료 보장 ---
// 진행 중인 채팅 추적
const pendingChats = new Map(); // agentId → { status, content, error }

ipcMain.handle('chat', (_, { agent, messages }) => {
  if (!ollamaReady) {
    checkOllama();
    if (!ollamaReady) {
      return { status: 'error', error: 'Ollama가 실행 중이 아니에요. 터미널에서 "ollama serve"를 실행해주세요.' };
    }
  }

  // 유저 메시지를 즉시 히스토리에 저장
  const today = new Date().toISOString().split('T')[0];
  const historyKey = `history-${agent}-${today}`;
  const lastUserMsg = messages[messages.length - 1];
  if (lastUserMsg && lastUserMsg.role === 'user') {
    const saved = store.get(historyKey, []);
    const already = saved.length > 0 && saved[saved.length - 1].content === lastUserMsg.content;
    if (!already) {
      saved.push({ role: 'user', content: lastUserMsg.content });
      store.set(historyKey, saved);
    }
  }

  // 백그라운드에서 Ollama 호출 — 창 닫혀도 계속 진행
  pendingChats.set(agent, { status: 'loading' });

  buildSystemPrompt(agent).then(systemPrompt => {
    return ollamaChat(systemPrompt, messages);
  }).then(content => {
    addXP(agent);
    // 히스토리에 응답 저장
    const saved = store.get(historyKey, []);
    saved.push({ role: 'assistant', content });
    store.set(historyKey, saved);
    pendingChats.set(agent, { status: 'done', content });

    // 렌더러가 살아있으면 알림
    if (chatWindow && !chatWindow.isDestroyed()) {
      chatWindow.webContents.send('chat-response', { agent, content });
    }
  }).catch(err => {
    pendingChats.set(agent, { status: 'error', error: err.message });
    if (chatWindow && !chatWindow.isDestroyed()) {
      chatWindow.webContents.send('chat-response', { agent, error: err.message });
    }
  });

  return { status: 'processing' };
});

ipcMain.handle('get-pending-chat', (_, agent) => {
  const pending = pendingChats.get(agent);
  if (pending && pending.status === 'done') pendingChats.delete(agent);
  return pending || null;
});

app.on('window-all-closed', (e) => {
  e.preventDefault();
});
