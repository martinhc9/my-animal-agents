const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, screen, shell, protocol, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const Store = require('electron-store');

const store = new Store();
let tray = null;
let floatBar = null;
let chatWindow = null;

// RSS 뉴스 캐시 (카피바라용)
const newsCache = { capybara: null };

// Ollama 설정
const OLLAMA_BASE = 'http://127.0.0.1:11434';
const DEFAULT_MODEL = 'korean-agent';
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

// --- 사용자 메모리 ---
function getMemories(agentId) {
  return store.get(`memory-${agentId}`, []);
}

function addMemory(agentId, fact) {
  const memories = getMemories(agentId);
  // 중복 방지
  if (memories.some(m => m === fact)) return;
  memories.push(fact);
  // 최대 30개 유지
  if (memories.length > 30) memories.shift();
  store.set(`memory-${agentId}`, memories);
}

// 대화 후 사용자 정보 자동 추출 (백그라운드)
async function extractMemory(agentId, userMessage, assistantResponse) {
  try {
    const existing = getMemories(agentId);
    const existingText = existing.length > 0 ? existing.join(', ') : '없음';

    const res = await fetch(`${OLLAMA_BASE}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: DEFAULT_MODEL,
        messages: [{
          role: 'user',
          content: `아래 대화에서 사용자에 대해 새로 알게 된 사실을 한 줄로 적어줘. 이름, 취미, 직업, 좋아하는 것, 기분, 상황 등. 이미 알고 있는 것과 중복되면 "없음"이라고 해. 새로운 사실이 없으면 "없음".

이미 알고 있는 것: ${existingText}

사용자: ${userMessage}
AI: ${assistantResponse}

새로 알게 된 사실 (한 줄, 또는 "없음"):`
        }],
        stream: false,
        options: { temperature: 0.1, num_predict: 100 },
      }),
    });

    if (res.ok) {
      const data = await res.json();
      const fact = data.message.content.trim();
      if (fact && fact !== '없음' && !fact.includes('없음') && fact.length > 2 && fact.length < 200) {
        addMemory(agentId, fact);
        console.log(`[Memory] ${agentId}: "${fact}"`);
      }
    }
  } catch { /* 메모리 추출 실패해도 무시 */ }
}

// --- 응답 프리캐시 (카피바라 제외) ---
// 각 캐릭터별 미리 생성된 응답 3개씩 보관
const responseCache = new Map(); // agentId → [string, string, string]

async function prefillCache(agentId) {
  if (agentId === 'capybara') return; // 실시간 데이터라 캐싱 불가
  const cache = responseCache.get(agentId) || [];
  if (cache.length >= 3) return; // 이미 충분

  const needed = 3 - cache.length;
  console.log(`[Cache] ${agentId}: ${needed}개 프리캐시 시작`);

  const prompts = {
    panda: '재미있는 퀴즈 하나 내줘. 4지선다로.',
    monkey: '오늘 힘든 하루를 보낸 사람에게 위로 한마디 해줘.',
    cat: '기분 좋아지는 노래 3곡 추천해줘. 유튜브 링크도.',
    nureong: '진짜 웃긴 일상 이야기 하나 들려줘. 컬투쇼 사연 느낌으로.',
  };

  for (let i = 0; i < needed; i++) {
    try {
      const systemPrompt = await buildSystemPrompt(agentId);
      const content = await ollamaChat(systemPrompt, [{ role: 'user', content: prompts[agentId] || '안녕' }]);
      cache.push(content);
      responseCache.set(agentId, cache);
      console.log(`[Cache] ${agentId}: ${cache.length}/3`);
    } catch { break; }
  }
}

// --- Ollama API ---
async function ollamaChat(systemPrompt, messages, onToken) {
  const body = {
    model: DEFAULT_MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      ...messages,
    ],
    stream: !!onToken,
    think: false,
    options: {
      temperature: 0.7,
      top_p: 0.9,
      num_predict: 512,
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

  if (!onToken) {
    const data = await res.json();
    return data.message.content;
  }

  // 스트리밍 모드
  let fullContent = '';
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    for (const line of chunk.split('\n')) {
      if (!line.trim()) continue;
      try {
        const json = JSON.parse(line);
        if (json.message?.content) {
          fullContent += json.message.content;
          onToken(fullContent);
        }
      } catch {}
    }
  }
  return fullContent;
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

  const savedOrientation = store.get('floatbar-orientation', 'horizontal');
  const isVertical = savedOrientation !== 'horizontal';

  floatBar = new BrowserWindow({
    ...bounds,
    frame: false,
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    transparent: true,
    hasShadow: false,
    minWidth: isVertical ? 80 : 200,
    minHeight: isVertical ? 200 : 80,
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
    // 저장된 수직/수평 모드 복원
    if (savedOrientation !== 'horizontal') {
      floatBar.webContents.send('orientation-change', savedOrientation);
    }
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
    : { x: Math.round(screenWidth / 2 - 210), y: screenHeight - 100, width: 420, height: 100 };
  const orientation = store.get('floatbar-orientation', 'horizontal');
  const chatWidth = 400;
  const chatHeight = 520;

  let chatX, chatY;
  if (orientation === 'vertical-left') {
    chatX = barBounds.x + barBounds.width + 10;
    chatY = Math.max(10, Math.round(barBounds.y + barBounds.height / 2 - chatHeight / 2));
  } else if (orientation === 'vertical-right') {
    chatX = barBounds.x - chatWidth - 10;
    chatY = Math.max(10, Math.round(barBounds.y + barBounds.height / 2 - chatHeight / 2));
  } else {
    chatX = Math.round(barBounds.x + barBounds.width / 2 - chatWidth / 2);
    chatY = Math.max(10, barBounds.y - chatHeight - 10);
  }
  chatX = Math.max(0, Math.min(screenWidth - chatWidth, chatX));
  chatY = Math.max(10, Math.min(screenHeight - chatHeight, chatY));

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
    // 트렌드 캐시는 앱 세션 동안 유지 (창 닫아도 초기화 안 함)
  });
}

// --- App 설정 ---
app.dock?.hide();

app.whenReady().then(async () => {
  createTray();
  createFloatBar();
  // 트렌드 미리 fetch
  fetchRealtimeTrends().then(t => { newsCache.capybara = t; console.log(`[Trends] ${t.length}개 로드`); });
  const ready = await checkOllama();
  // 모델 워밍업 — 첫 응답 지연 방지
  if (ready) {
    console.log('[Ollama] 모델 워밍업 시작...');
    try {
      await fetch(`${OLLAMA_BASE}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: DEFAULT_MODEL, messages: [{ role: 'user', content: '안녕' }], stream: false, think: false, options: { num_predict: 5 } }),
      });
      console.log('[Ollama] 워밍업 완료');
      // 백그라운드 프리캐시
      (async () => {
        for (const id of ['panda', 'monkey', 'cat', 'nureong']) {
          await prefillCache(id);
        }
        console.log('[Cache] 프리캐시 완료');
      })();
    } catch { console.log('[Ollama] 워밍업 실패'); }
  }
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
  panda: '게임 대결 친구! 사용자와 퀴즈, 끝말잇기, 넌센스 퀴즈, 초성 퀴즈, 스무고개 등 다양한 미니게임을 해줘. 처음에 "어떤 게임 할래?" 물어보고, 사용자가 고르면 바로 시작. 점수를 기록하고, 이기면 축하, 지면 도발하면서 재대결 유도해.',
  monkey: '멘탈 케어 친구. 사용자의 기분을 물어보고, 위로/격려/용기를 줘. 먼저 공감하고 경청해. 힘든 이야기에는 위로를, 좋은 이야기에는 함께 기뻐해줘.',
  cat: '음악 큐레이터. 사용자의 기분/상황에 맞는 좋은 노래 3곡 추천. 실제 존재하는 유명한 곡만. 아티스트, 곡 제목, 추천 이유, 유튜브 검색 링크 포함.',
  capybara: '실시간 핫 이슈 알리미. 오늘 바로 지금 인스타, X(트위터), 커뮤니티에서 핫한 밈, 화제, 이슈를 알려줘. "지금 뭐가 핫해?" 하면 바로 답. 밈이면 설명도 해줘.',
  nureong: '이야기꾼. 컬투쇼 레전드 사연 같은 진짜 웃긴 일상 이야기를 들려줘. 공감 가고, 반전 있고, 빵 터지는 실제 에피소드 스타일. 한 번에 1개씩. 19금 금지.',
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
    floatBar.setPosition(x + dx, y + dy);
  }
});

// 드래그 끝났을 때만 방향 판단 + 위치 저장
ipcMain.handle('drag-end', () => {
  if (!floatBar || floatBar.isDestroyed()) return;

  const { width: sw } = screen.getPrimaryDisplay().workAreaSize;
  const bounds = floatBar.getBounds();
  const EDGE = 10;

  let orientation = 'horizontal';
  if (bounds.x <= EDGE) orientation = 'vertical-left';
  else if (bounds.x + bounds.width >= sw - EDGE) orientation = 'vertical-right';

  const prev = store.get('floatbar-orientation', 'horizontal');
  if (orientation !== prev) {
    const { height: sh } = screen.getPrimaryDisplay().workAreaSize;
    if (orientation === 'horizontal') {
      floatBar.setMinimumSize(200, 80);
      floatBar.setMaximumSize(9999, 120);
      floatBar.setBounds({ x: bounds.x, y: sh - 100, width: 420, height: 100 });
    } else if (orientation === 'vertical-left') {
      floatBar.setMinimumSize(80, 200);
      floatBar.setMaximumSize(120, 9999);
      floatBar.setBounds({ x: 0, y: Math.round(sh / 2 - 210), width: 100, height: 420 });
    } else {
      floatBar.setMinimumSize(80, 200);
      floatBar.setMaximumSize(120, 9999);
      floatBar.setBounds({ x: sw - 100, y: Math.round(sh / 2 - 210), width: 100, height: 420 });
    }
    store.set('floatbar-orientation', orientation);
    floatBar.webContents.send('orientation-change', orientation);
  }

  store.set('floatbar-bounds', floatBar.getBounds());
});

ipcMain.handle('reset-bar-position', () => {
  const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize;
  const bounds = { width: 420, height: 100, x: Math.round(screenWidth / 2 - 210), y: screenHeight - 100 };
  store.delete('floatbar-bounds');
  store.delete('floatbar-orientation');
  if (floatBar && !floatBar.isDestroyed()) {
    floatBar.setMinimumSize(200, 80);
    floatBar.setMaximumSize(9999, 120);
    floatBar.setBounds(bounds);
    floatBar.webContents.send('orientation-change', 'horizontal');
  }
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

// --- 실시간 트렌드 (Google Trends 한국) ---
async function fetchRealtimeTrends() {
  try {
    const res = await fetch('https://trends.google.co.kr/trending/rss?geo=KR');
    const xml = await res.text();
    const items = [];
    const re = /<item>([\s\S]*?)<\/item>/g;
    let m;
    while ((m = re.exec(xml)) !== null && items.length < 5) {
      const x = m[1];
      const keyword = (x.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '';
      const traffic = (x.match(/<ht:approx_traffic>([\s\S]*?)<\/ht:approx_traffic>/) || [])[1] || '';
      const newsTitle = (x.match(/<ht:news_item_title>([\s\S]*?)<\/ht:news_item_title>/) || [])[1] || '';
      const newsUrl = (x.match(/<ht:news_item_url>([\s\S]*?)<\/ht:news_item_url>/) || [])[1] || '';
      const newsSource = (x.match(/<ht:news_item_source>([\s\S]*?)<\/ht:news_item_source>/) || [])[1] || '';
      if (keyword) {
        items.push({
          keyword: keyword.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&apos;/g, "'").replace(/&amp;/g, '&').trim(),
          traffic,
          newsTitle: newsTitle.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&apos;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"').trim(),
          newsUrl: newsUrl.replace(/&amp;/g, '&'),
          newsSource,
        });
      }
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
  const memories = getMemories(agent);
  const memoryText = memories.length > 0
    ? `\n[사용자에 대해 기억하는 것]\n${memories.map((m, i) => `- ${m}`).join('\n')}\n`
    : '';
  const ctx = `\n[친밀도 Lv.${affinity.level} | 연속 ${affinity.streak}일]\n말투: ${tone}\n${memoryText}`;

  // 커스텀 역할이 있으면 우선 사용
  const custom = store.get(`custom-${agent}`, null);
  if (custom && custom.role) {
    const name = custom.name || agent;
    return `너는 "${name}"이라는 이름의 AI 에이전트야.\n역할: ${custom.role}\n오늘: ${today}${ctx}\n반드시 한국어로만 답변해.`;
  }

  const prompts = {
    panda: `너는 "팬더"라는 이름의 판다 게임 대결 친구야. 활발하고 승부욕 강한 캐릭터.\n역할: 사용자와 퀴즈, 끝말잇기, 넌센스 퀴즈, 초성 퀴즈, 스무고개 등 미니게임을 해줘.\n처음에 "어떤 게임 할래? 🎮" 물어봐. 점수 기록하고, 이기면 축하, 지면 도발!\n오늘: ${today}${ctx}\n한국어로 답변해.`,
    monkey: `너는 "펀치"라는 이름의 원숭이 멘탈 케어 친구야.\n역할: 사용자의 기분을 물어보고, 위로/격려/용기를 줘.\n오늘: ${today}${ctx}\n한국어로 답변해.`,
    cat: `너는 "야옹이"라는 이름의 고양이 음악 큐레이터야.\n역할: 사용자의 기분/상황에 맞는 좋은 노래 3곡을 추천해줘.\n실제로 존재하는 유명한 곡만 추천해.\n각 곡마다: 아티스트 - 곡 제목, 추천 이유 한 줄, 유튜브 검색 링크(https://www.youtube.com/results?search_query=아티스트+곡제목 형태)\n한국 노래와 팝송을 섞어줘.\n오늘: ${today}${ctx}\n한국어로 답변해.`,
    capybara: `CAPYBARA_PLACEHOLDER`,
    nureong: `너는 "벨루가"라는 이름의 흰고래 이야기꾼이야. 느긋하고 재밌는 톤.\n역할: 컬투쇼 레전드 사연 같은 진짜 웃긴 일상 이야기를 들려줘. 공감 가고, 반전 있고, 빵 터지는 실제 에피소드 스타일. 한 번에 1개씩.\n오늘: ${today}${ctx}\n19금 금지. 한국어로 답변해.`,
  };

  // 판다는 게임 대결로 변경됨 — HR 뉴스 fetch 불필요

  if (agent === 'capybara') {
    if (!newsCache.capybara) newsCache.capybara = await fetchRealtimeTrends();
    const trends = newsCache.capybara;
    const trendText = trends.length > 0
      ? trends.map((t, i) => `${i+1}. ${t.keyword} - ${t.newsTitle}`).join('\n')
      : '(트렌드 없음)';
    prompts.capybara = `너는 "카피바라". 실시간 핫이슈 알리미.\n지금 한국 실시간 인기 검색어:\n${trendText}\n\n위 키워드를 짧게 설명해. 왜 핫한지 한 줄씩.\n오늘: ${today}${ctx}\n한국어로 답변해.`;
  }

  return prompts[agent] || prompts.panda;
}

// --- Chat handler (Ollama) — 비동기 처리, 창 닫혀도 완료 보장 ---
// 진행 중인 채팅 추적
const pendingChats = new Map(); // agentId → { status, content, error }

ipcMain.handle('chat', async (_, { agent, messages }) => {
  if (!ollamaReady) {
    await checkOllama();
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

  // 캐시에 미리 생성된 응답이 있으면 즉시 사용 (첫 메시지일 때)
  const cache = responseCache.get(agent) || [];
  if (cache.length > 0 && messages.length <= 2) {
    const cached = cache.shift();
    responseCache.set(agent, cache);
    // 캐시 보충 (백그라운드)
    prefillCache(agent);

    pendingChats.set(agent, { status: 'done', content: cached });
    addXP(agent);
    const saved = store.get(historyKey, []);
    saved.push({ role: 'assistant', content: cached });
    store.set(historyKey, saved);
    if (chatWindow && !chatWindow.isDestroyed()) {
      chatWindow.webContents.send('chat-response', { agent, content: cached });
    }
    const userMsg = lastUserMsg?.content || '';
    if (userMsg) extractMemory(agent, userMsg, cached);
    return { status: 'processing' };
  }

  // 캐시 없으면 실시간 생성
  pendingChats.set(agent, { status: 'loading' });

  (async () => {
    const systemPrompt = await buildSystemPrompt(agent);
    return ollamaChat(systemPrompt, messages, (partial) => {
      // 스트리밍 토큰을 렌더러에 전달
      if (chatWindow && !chatWindow.isDestroyed()) {
        chatWindow.webContents.send('chat-stream', { agent, partial });
      }
    });
  })().then(content => {
    addXP(agent);
    // 히스토리에 응답 저장
    const saved = store.get(historyKey, []);
    saved.push({ role: 'assistant', content });
    store.set(historyKey, saved);
    pendingChats.set(agent, { status: 'done', content });

    // 백그라운드 메모리 추출
    const userMsg = lastUserMsg?.content || '';
    if (userMsg) extractMemory(agent, userMsg, content);

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
