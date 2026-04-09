const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, screen, shell, protocol, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { execSync, spawn } = require('child_process');
const Store = require('electron-store');


const store = new Store();
let tray = null;
let floatBar = null;
let chatWindow = null;

// RSS 뉴스 캐시 (카피바라용)
const newsCache = { capybara: null };

// 식당 목록 (점메추봇용)
let restaurantList = [];
try {
  restaurantList = JSON.parse(fs.readFileSync(path.join(__dirname, 'assets', 'restaurants.json'), 'utf-8'));
} catch (e) {
  console.error('[Restaurants] 식당 목록 로드 실패:', e.message);
}

// Ollama 설정
const OLLAMA_BASE = 'http://127.0.0.1:11434';
const DEFAULT_MODEL = 'korean-agent-e2b'; // e2b 테스트
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

  // 스트리밍 모드 (쓰로틀링: 50ms 간격으로 UI 업데이트)
  let fullContent = '';
  let lastSent = 0;
  let pendingFlush = null;
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
          const now = Date.now();
          if (now - lastSent >= 50) {
            if (pendingFlush) { clearTimeout(pendingFlush); pendingFlush = null; }
            onToken(fullContent);
            lastSent = now;
          } else if (!pendingFlush) {
            pendingFlush = setTimeout(() => {
              onToken(fullContent);
              lastSent = Date.now();
              pendingFlush = null;
            }, 50 - (now - lastSent));
          }
        }
      } catch {}
    }
  }
  if (pendingFlush) { clearTimeout(pendingFlush); }
  onToken(fullContent); // 마지막 상태 확실히 전달
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
    width: 440, height: 84,
    x: Math.round(screenWidth / 2 - 220),
    y: screenHeight - 84,
  };

  let bounds = defaultBounds;
  const savedBounds = store.get('floatbar-bounds', null);
  if (savedBounds && savedBounds.x >= 0 && savedBounds.y >= 0
      && savedBounds.x < screenWidth && savedBounds.y < screenHeight) {
    bounds = savedBounds;
  } else {
    store.delete('floatbar-bounds');
  }

  const barPos = store.get('bar-position', 'bottom');
  const isVertical = barPos === 'left' || barPos === 'right';

  floatBar = new BrowserWindow({
    ...bounds,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    transparent: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  floatBar.loadFile(path.join(__dirname, 'renderer', 'float-bar.html'));
  floatBar.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // 기본: 숨김 상태, hover로만 나타남
  floatBar.hide();

  const saveBounds = () => {
    if (floatBar && !floatBar.isDestroyed()) {
      store.set('floatbar-bounds', floatBar.getBounds());
    }
  };
  floatBar.on('moved', saveBounds);
  floatBar.on('resized', saveBounds);
}

// 항상표시 OFF: 마우스가 바 영역 근처면 표시, 벗어나면 숨김
let barHoverTimer = null;
let barFading = false; // 페이드 중 중복 방지
function startBarHoverWatch() {
  if (barHoverTimer) return;
  barHoverTimer = setInterval(() => {
    if (!floatBar || floatBar.isDestroyed() || barFading) return;

    const cursor = screen.getCursorScreenPoint();
    const b = floatBar.getBounds();
    const m = 30;
    const inside = cursor.x >= b.x - m && cursor.x <= b.x + b.width + m
                && cursor.y >= b.y - m && cursor.y <= b.y + b.height + m;

    if (hideTimer) return; // 감추기 모드 중에는 hover 무시

    if (inside && !floatBar.isVisible()) {
      // 페이드 인 (300ms easeOut)
      barFading = true;
      floatBar.setOpacity(0);
      floatBar.showInactive();
      const fadeStart = Date.now();
      const fadeDuration = 300;
      const fadeIn = setInterval(() => {
        const t = Math.min(1, (Date.now() - fadeStart) / fadeDuration);
        const ease = 1 - Math.pow(1 - t, 3); // easeOutCubic
        if (floatBar && !floatBar.isDestroyed()) floatBar.setOpacity(ease);
        if (t >= 1) { clearInterval(fadeIn); barFading = false; }
      }, 8);
    } else if (!inside && floatBar.isVisible()) {
      if (!chatWindow || chatWindow.isDestroyed()) {
        // 페이드 아웃 (400ms easeIn)
        barFading = true;
        const fadeStart = Date.now();
        const fadeDuration = 400;
        const fadeOut = setInterval(() => {
          const t = Math.min(1, (Date.now() - fadeStart) / fadeDuration);
          const ease = 1 - Math.pow(t, 3); // easeInCubic (역방향)
          if (floatBar && !floatBar.isDestroyed()) {
            floatBar.setOpacity(ease);
            if (t >= 1) {
              floatBar.hide();
              floatBar.setOpacity(1);
              clearInterval(fadeOut);
              barFading = false;
            }
          } else { clearInterval(fadeOut); barFading = false; }
        }, 8);
      }
    }
  }, 300);
}
startBarHoverWatch();

let hideTimer = null;
function hideBarFor(minutes) {
  if (floatBar && !floatBar.isDestroyed()) floatBar.hide();
  store.set('bar-pinned', false);
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    store.set('bar-pinned', true);
    if (floatBar && !floatBar.isDestroyed()) floatBar.show();
    hideTimer = null;
  }, minutes * 60 * 1000);
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
  tray.setToolTip('My Animal Agents');
  if (trayImage.isEmpty()) tray.setTitle('🐾');

  // 트레이 아이콘 클릭 시 바 토글
  tray.on('click', () => {
    if (floatBar && !floatBar.isDestroyed()) {
      // 감추기 모드 해제
      if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    }
  });

  const trayMenu = Menu.buildFromTemplate([
    { label: '10분간 감추기', click: () => hideBarFor(10) },
    { label: '1시간 감추기', click: () => hideBarFor(60) },
    { label: '설정', click: () => createChatWindow('settings') },
    { label: '원위치 복귀', click: () => {
      const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
      store.delete('floatbar-bounds');
      if (floatBar && !floatBar.isDestroyed()) {
        floatBar.setBounds({ width: 440, height: 84, x: Math.round(sw / 2 - 220), y: sh - 84 });
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
    : { x: Math.round(screenWidth / 2 - 220), y: screenHeight - 84, width: 440, height: 84 };
  const chatWidth = 400;
  const chatHeight = 520;
  const barPos = store.get('bar-position', 'bottom');
  let chatX, chatY;
  if (barPos === 'left') {
    chatX = barBounds.x + barBounds.width + 10;
    chatY = Math.round(barBounds.y + barBounds.height / 2 - chatHeight / 2);
  } else if (barPos === 'right') {
    chatX = barBounds.x - chatWidth - 10;
    chatY = Math.round(barBounds.y + barBounds.height / 2 - chatHeight / 2);
  } else if (barPos === 'top') {
    chatX = Math.round(barBounds.x + barBounds.width / 2 - chatWidth / 2);
    chatY = barBounds.y + barBounds.height + 10;
  } else {
    chatX = Math.round(barBounds.x + barBounds.width / 2 - chatWidth / 2);
    chatY = barBounds.y - chatHeight - 10;
  }
  chatX = Math.max(0, Math.min(screenWidth - chatWidth, chatX));
  chatY = Math.max(10, Math.min(screenHeight - chatHeight, chatY));

  chatWindow = new BrowserWindow({
    width: chatWidth,
    height: chatHeight,
    x: chatX,
    y: chatY,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    transparent: false,
    backgroundColor: '#1a1a2e',
    hasShadow: true,
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

  chatWindow.on('blur', () => {
    if (chatWindow && !chatWindow.isDestroyed()) {
      chatWindow.close();
    }
  });

  chatWindow.on('closed', () => {
    chatWindow = null;
    // 트렌드 캐시는 앱 세션 동안 유지 (창 닫아도 초기화 안 함)
  });
}

// --- App 설정 ---
// app.dock?.hide()는 startApp()에서 호출

// --- 온보딩: Ollama 설치/실행/모델 체크 ---
let setupWindow = null;

// ollama 바이너리 경로 탐색
function findOllamaBin() {
  const candidates = [
    '/usr/local/bin/ollama',
    '/opt/homebrew/bin/ollama',
    path.join(app.getPath('home'), 'Applications', 'Ollama.app', 'Contents', 'Resources', 'ollama'),
    '/Applications/Ollama.app/Contents/Resources/ollama',
  ];
  try {
    const which = execSync('which ollama', { encoding: 'utf-8' }).trim();
    if (which) candidates.unshift(which);
  } catch {}
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return 'ollama'; // fallback to PATH
}

function isOllamaInstalled() {
  try {
    const bin = findOllamaBin();
    execSync(`"${bin}" --version`, { encoding: 'utf-8' });
    return true;
  } catch { return false; }
}

async function isOllamaRunning() {
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/tags`);
    return res.ok;
  } catch { return false; }
}

async function hasModel() {
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/tags`);
    const data = await res.json();
    return data.models?.some(m => m.name === DEFAULT_MODEL || m.name.startsWith(DEFAULT_MODEL.split(':')[0]));
  } catch { return false; }
}

function createSetupWindow() {
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  setupWindow = new BrowserWindow({
    width: 480,
    height: 560,
    x: Math.round(sw / 2 - 240),
    y: Math.round(sh / 2 - 210),
    frame: true,
    resizable: false,
    alwaysOnTop: true,
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  setupWindow.loadFile(path.join(__dirname, 'renderer', 'setup.html'));
  setupWindow.on('closed', () => { setupWindow = null; });
}

function sendSetup(data) {
  if (setupWindow && !setupWindow.isDestroyed()) {
    setupWindow.webContents.send('setup-progress', data);
  }
}

async function runSetup() {
  // Step 1: Ollama 설치
  if (!isOllamaInstalled()) {
    sendSetup({ step: 'install', status: 'active', message: 'Ollama 다운로드 중...', progress: 0 });
    try {
      const tmpZip = path.join(app.getPath('temp'), 'Ollama-darwin.zip');
      // Node.js https로 직접 다운로드 (리다이렉트 따라감)
      await new Promise((resolve, reject) => {
        const download = (url) => {
          const mod = url.startsWith('https') ? require('https') : require('http');
          mod.get(url, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
              download(res.headers.location);
              return;
            }
            if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return; }
            const total = parseInt(res.headers['content-length'] || '0', 10);
            let downloaded = 0;
            const file = fs.createWriteStream(tmpZip);
            res.on('data', (chunk) => {
              downloaded += chunk.length;
              if (total > 0) {
                const pct = Math.round(downloaded / total * 100);
                sendSetup({ step: 'install', status: 'active', progress: pct, message: `Ollama 다운로드 중... ${pct}%` });
              }
            });
            res.pipe(file);
            file.on('finish', () => { file.close(); resolve(); });
            file.on('error', reject);
          }).on('error', reject);
        };
        download('https://ollama.com/download/Ollama-darwin.zip');
      });

      sendSetup({ step: 'install', status: 'active', message: 'Ollama 설치 중...' });
      // zip 해제
      const tmpDir = path.join(app.getPath('temp'), 'ollama-extract');
      await new Promise((resolve, reject) => {
        const proc = spawn('unzip', ['-o', tmpZip, '-d', tmpDir], { stdio: 'pipe' });
        proc.on('close', code => code === 0 ? resolve() : reject(new Error(`압축 해제 실패`)));
        proc.on('error', reject);
      });
      // ~/Applications 또는 /Applications에 복사 (권한 있는 쪽으로)
      const homeApps = path.join(app.getPath('home'), 'Applications');
      if (!fs.existsSync(homeApps)) fs.mkdirSync(homeApps, { recursive: true });
      let ollamaAppPath = path.join(homeApps, 'Ollama.app');
      try {
        await new Promise((resolve, reject) => {
          const proc = spawn('cp', ['-R', path.join(tmpDir, 'Ollama.app'), '/Applications/'], { stdio: 'pipe' });
          proc.on('close', code => code === 0 ? resolve() : reject(new Error('권한 없음')));
          proc.on('error', reject);
        });
        ollamaAppPath = '/Applications/Ollama.app';
      } catch {
        // /Applications 실패 시 ~/Applications로
        await new Promise((resolve, reject) => {
          const proc = spawn('cp', ['-R', path.join(tmpDir, 'Ollama.app'), homeApps + '/'], { stdio: 'pipe' });
          proc.on('close', code => code === 0 ? resolve() : reject(new Error(`복사 실패`)));
          proc.on('error', reject);
        });
      }
      // ollama serve 백그라운드 실행 (GUI 없이)
      const ollamaBin = path.join(ollamaAppPath, 'Contents', 'Resources', 'ollama');
      spawn(ollamaBin, ['serve'], { stdio: 'ignore', detached: true }).unref();
      // CLI 준비 대기 (PATH에 없을 수 있으니 직접 체크도)
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 500));
        if (isOllamaInstalled()) break;
        // 직접 바이너리로도 체크
        try {
          execSync(`"${ollamaBin}" --version`, { encoding: 'utf-8' });
          break;
        } catch {}
      }
    } catch (e) {
      sendSetup({ step: 'install', status: 'error', message: `설치 실패: ${e.message}` });
      return;
    }
  }
  sendSetup({ step: 'install', status: 'done' });

  // Step 2: Ollama 실행
  sendSetup({ step: 'serve', status: 'active', message: 'Ollama 시작 중...' });
  if (!(await isOllamaRunning())) {
    // 백그라운드로 ollama serve 실행
    const srv = spawn(findOllamaBin(), ['serve'], { stdio: 'ignore', detached: true });
    srv.unref();
    // 포트 열릴 때까지 대기 (최대 15초)
    let running = false;
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 500));
      if (await isOllamaRunning()) { running = true; break; }
    }
    if (!running) {
      sendSetup({ step: 'serve', status: 'error', message: 'Ollama 시작 실패' });
      return;
    }
  }
  sendSetup({ step: 'serve', status: 'done' });

  // Step 3: gemma4 모델 다운로드
  sendSetup({ step: 'pull', status: 'active', message: 'AI 모델 다운로드 중...', progress: 0 });
  const hasGemma = await (async () => {
    try {
      const res = await fetch(`${OLLAMA_BASE}/api/tags`);
      const data = await res.json();
      return data.models?.some(m => m.name.startsWith('gemma4'));
    } catch { return false; }
  })();

  if (!hasGemma) {
    try {
      await new Promise((resolve, reject) => {
        const proc = spawn(findOllamaBin(), ['pull', 'gemma4:e2b'], { stdio: 'pipe' });
        let lastPct = 0;
        const handleData = (chunk) => {
          const text = chunk.toString();
          const match = text.match(/(\d+)%/);
          if (match) {
            lastPct = parseInt(match[1]);
            sendSetup({ step: 'pull', status: 'active', progress: lastPct, message: `AI 모델 다운로드 중... ${lastPct}%` });
          }
        };
        proc.stdout.on('data', handleData);
        proc.stderr.on('data', handleData);
        proc.on('close', code => code === 0 ? resolve() : reject(new Error(`exit ${code}`)));
        proc.on('error', reject);
      });
    } catch (e) {
      sendSetup({ step: 'pull', status: 'error', message: `다운로드 실패: ${e.message}` });
      return;
    }
  }
  sendSetup({ step: 'pull', status: 'done', progress: 100 });

  // Step 4: korean-agent 모델 생성
  sendSetup({ step: 'create', status: 'active', message: '에이전트 모델 생성 중...' });
  if (!(await hasModel())) {
    try {
      // asar 안의 Modelfile을 임시 파일로 복사 (ollama CLI가 asar 못 읽음)
      const modelfileSrc = path.join(__dirname, 'assets', 'Modelfile.e2b');
      const modelfileTmp = path.join(app.getPath('temp'), 'Modelfile');
      fs.copyFileSync(modelfileSrc, modelfileTmp);
      await new Promise((resolve, reject) => {
        const proc = spawn(findOllamaBin(), ['create', DEFAULT_MODEL, '-f', modelfileTmp], { stdio: 'pipe' });
        proc.on('close', code => code === 0 ? resolve() : reject(new Error(`exit ${code}`)));
        proc.on('error', reject);
      });
    } catch (e) {
      sendSetup({ step: 'create', status: 'error', message: `모델 생성 실패: ${e.message}` });
      return;
    }
  }
  sendSetup({ step: 'create', status: 'done' });

  // 완료
  sendSetup({ step: 'done', status: 'done' });
}

ipcMain.handle('start-setup', () => runSetup());
ipcMain.handle('setup-complete', () => {
  if (setupWindow && !setupWindow.isDestroyed()) {
    setupWindow.close();
    setupWindow = null;
  }
  startApp();
});

async function startApp() {
  app.dock?.hide(); // 트레이 + 바 준비된 후 Dock 숨김
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
    } catch { console.log('[Ollama] 워밍업 실패'); }
  }
}

app.whenReady().then(async () => {
  // Ollama + 모델 모두 준비됐으면 바로 시작
  const installed = isOllamaInstalled();
  const running = installed && (await isOllamaRunning());
  const model = running && (await hasModel());

  if (installed && running && model) {
    startApp();
  } else {
    // 셋업 필요
    createSetupWindow();
  }
});

// --- IPC handlers ---
ipcMain.handle('open-agent', (_, agentId) => createChatWindow(agentId));
ipcMain.handle('open-settings', () => createChatWindow('settings'));

// 캐릭터 커스터마이징
const DEFAULT_AGENTS_ORDER = ['capybara', 'panda', 'cat', 'monkey', 'nureong'];

ipcMain.handle('get-agents-order', () => DEFAULT_AGENTS_ORDER);
ipcMain.handle('set-agents-order', () => true); // 순서 변경 비활성화

ipcMain.handle('get-agent-custom', (_, agentId) => store.get(`custom-${agentId}`, null));
ipcMain.handle('set-agent-custom', (_, { agentId, name, role }) => {
  store.set(`custom-${agentId}`, { name, role });
  // 프롬프트 변경 시 메모리도 초기화 (이전 성격 기억 제거)
  store.delete(`memory-${agentId}`);
  return true;
});
ipcMain.handle('reset-agent-custom', (_, agentId) => {
  store.delete(`custom-${agentId}`);
  store.delete(`memory-${agentId}`);
  return true;
});

// 기본 역할 프롬프트
const DEFAULT_ROLE_PROMPTS = {
  panda: '점심 메뉴 추천 봇! 사용자의 기분, 날씨, 상황에 맞는 점심 메뉴를 추천해줘. "뭐 먹지?" 하면 바로 3가지 메뉴를 추천하고, 각 메뉴의 매력 포인트를 한 줄로 설명해. 사용자가 고민하면 하나를 콕 찍어줘.',
  monkey: '멘탈 케어 친구. 사용자의 기분을 물어보고, 위로/격려/용기를 줘. 먼저 공감하고 경청해. 힘든 이야기에는 위로를, 좋은 이야기에는 함께 기뻐해줘.',
  cat: '음악 큐레이터. 사용자의 기분/상황에 맞는 좋은 노래 3곡 추천. 실제 존재하는 유명한 곡만. 아티스트, 곡 제목, 추천 이유, 유튜브 검색 링크 포함.',
  capybara: '실시간 핫 이슈 알리미. 오늘 바로 지금 인스타, X(트위터), 커뮤니티에서 핫한 밈, 화제, 이슈를 알려줘. "지금 뭐가 핫해?" 하면 바로 답. 밈이면 설명도 해줘.',
  nureong: '이야기꾼. 컬투쇼 레전드 사연 같은 진짜 웃긴 일상 이야기를 들려줘. 공감 가고, 반전 있고, 빵 터지는 실제 에피소드 스타일. 한 번에 1개씩. 19금 금지.',
};

ipcMain.handle('get-default-role', (_, agentId) => DEFAULT_ROLE_PROMPTS[agentId] || '');

// 이미지 변경
// 원본 이미지 백업 디렉토리 (app.asar 밖, 사용자 데이터 폴더)
const backupDir = path.join(app.getPath('userData'), 'originals');
if (!fs.existsSync(backupDir)) {
  fs.mkdirSync(backupDir, { recursive: true });
  // 최초 1회: 현재 이미지를 원본으로 백업
  for (const id of ['panda', 'monkey', 'cat', 'capybara', 'nureong']) {
    for (let lv = 1; lv <= 5; lv++) {
      const src = path.join(__dirname, 'assets', `${id}-lv${lv}.png`);
      const dst = path.join(backupDir, `${id}-lv${lv}.png`);
      if (fs.existsSync(src) && !fs.existsSync(dst)) fs.copyFileSync(src, dst);
    }
  }
}

// 커스텀 이미지 저장 디렉토리 (app.asar 밖)
const customImgDir = path.join(app.getPath('userData'), 'custom-images');
if (!fs.existsSync(customImgDir)) fs.mkdirSync(customImgDir, { recursive: true });

ipcMain.handle('pick-agent-image', async (_, agentId) => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
  });
  if (result.canceled || !result.filePaths[0]) return null;

  const srcPath = result.filePaths[0];
  for (let lv = 1; lv <= 5; lv++) {
    fs.copyFileSync(srcPath, path.join(customImgDir, `${agentId}-lv${lv}.png`));
  }
  store.set(`custom-image-${agentId}`, true);
  if (floatBar && !floatBar.isDestroyed()) floatBar.webContents.reload();
  if (chatWindow && !chatWindow.isDestroyed()) chatWindow.webContents.reload();
  return { success: true };
});

ipcMain.handle('reset-agent-image', (_, agentId) => {
  for (let lv = 1; lv <= 5; lv++) {
    const custom = path.join(customImgDir, `${agentId}-lv${lv}.png`);
    if (fs.existsSync(custom)) fs.unlinkSync(custom);
  }
  store.delete(`custom-image-${agentId}`);
  if (floatBar && !floatBar.isDestroyed()) floatBar.webContents.reload();
  return true;
});

// 이미지 경로 해결: 커스텀 이미지가 있으면 그것, 없으면 원본
ipcMain.handle('get-agent-image-path', (_, agentId, level) => {
  const custom = path.join(customImgDir, `${agentId}-lv${level}.png`);
  if (store.get(`custom-image-${agentId}`) && fs.existsSync(custom)) return custom;
  return path.join(__dirname, 'assets', `${agentId}-lv${level}.png`);
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
  if (floatBar && !floatBar.isDestroyed()) {
    floatBar.setIgnoreMouseEvents(through, { forward: true });
  }
});

ipcMain.handle('move-bar-by', (_, dx, dy) => {
  if (floatBar && !floatBar.isDestroyed()) {
    const [x, y] = floatBar.getPosition();
    floatBar.setPosition(x + dx, y + dy);
  }
});

// 드래그 끝 → 위치 저장
ipcMain.handle('drag-end', () => {
  if (!floatBar || floatBar.isDestroyed()) return;
  store.set('floatbar-bounds', floatBar.getBounds());
});

function applyBarPosition(pos) {
  if (!floatBar || floatBar.isDestroyed()) return;
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  const isVertical = pos === 'left' || pos === 'right';

  if (isVertical) {
    const w = 84, h = 440;
    const x = pos === 'left' ? 0 : sw - w;
    const y = Math.round(sh / 2 - h / 2);
    floatBar.setBounds({ x, y, width: w, height: h });
  } else {
    const w = 440, h = 84;
    const x = Math.round(sw / 2 - w / 2);
    const y = pos === 'top' ? 0 : sh - h;
    floatBar.setBounds({ x, y, width: w, height: h });
  }

  store.set('bar-position', pos);
  store.set('floatbar-bounds', floatBar.getBounds());
  floatBar.webContents.send('bar-layout', isVertical ? 'vertical' : 'horizontal');
}

ipcMain.handle('set-bar-position', (_, pos) => { applyBarPosition(pos); return true; });
ipcMain.handle('get-bar-position', () => store.get('bar-position', 'bottom'));

ipcMain.handle('set-bar-pinned', (_, pinned) => {
  store.set('bar-pinned', pinned);
  if (floatBar && !floatBar.isDestroyed()) {
    if (pinned) {
      floatBar.show();
      floatBar.setIgnoreMouseEvents(false);
    } else {
      floatBar.hide();
    }
    floatBar.webContents.send('bar-pinned', pinned);
  }
  return true;
});
ipcMain.handle('get-bar-pinned', () => store.get('bar-pinned', true));

ipcMain.handle('reset-bar-position', () => {
  applyBarPosition('bottom');
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
    while ((m = re.exec(xml)) !== null && items.length < 3) {
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
    panda: `너는 "푸바오"라는 이름의 판다 점심 메뉴 추천 봇이야. 친근하고 맛집에 빠삭한 캐릭터.\n역할: 아래 식당 목록에서 사용자의 기분, 날씨, 상황에 맞는 점심 메뉴를 추천해줘.\n"뭐 먹지?" 하면 3가지 식당을 추천하고 각각 매력 포인트 한 줄. 고민하면 하나를 콕 찍어줘.\n반드시 아래 목록에 있는 식당만 추천해.\n\n[식당 목록]\n${restaurantList.map(r => `${r.name}(${r.type})`).join(', ')}\n\n오늘: ${today}${ctx}\n한국어로 답변해.`,
    monkey: `너는 "펀치"라는 이름의 원숭이 멘탈 케어 친구야.\n역할: 사용자의 기분을 물어보고, 위로/격려/용기를 줘.\n오늘: ${today}${ctx}\n한국어로 답변해.`,
    cat: `너는 "고양이"라는 이름의 고양이 음악 큐레이터야.\n역할: 사용자의 기분/상황에 맞는 좋은 노래 3곡을 추천해줘.\n실제로 존재하는 유명한 곡만 추천해.\n각 곡마다: 아티스트 - 곡 제목, 추천 이유 한 줄, 유튜브 검색 링크(https://www.youtube.com/results?search_query=아티스트+곡제목 형태)\n한국 노래와 팝송을 섞어줘.\n오늘: ${today}${ctx}\n한국어로 답변해.`,
    capybara: `CAPYBARA_PLACEHOLDER`,
    nureong: `너는 "누렁이"라는 이름의 강아지 이야기꾼이야. 느긋하고 재밌는 톤.\n역할: 컬투쇼 레전드 사연 같은 진짜 웃긴 일상 이야기를 들려줘. 공감 가고, 반전 있고, 빵 터지는 실제 에피소드 스타일. 한 번에 1개씩.\n오늘: ${today}${ctx}\n19금 금지. 한국어로 답변해.`,
  };

  // 판다는 점메추봇으로 변경됨 — HR 뉴스 fetch 불필요

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
  // 실시간 생성
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
