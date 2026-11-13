/**
 * 테니스장 게임 대기판 (코트 2면) — Google Apps Script 웹앱
 * - 이름 없이 '이모지'로만 운영 (개인정보 저장 안 함)
 * - 데이터는 스크립트 속성(PropertiesService)에 저장 → 시트 없이 동작
 * - 배포: 배포 > 새 배포 > 웹 앱 / 실행: 나 / 액세스: 모든 사용자
 */

const GAME_MIN = 30;          // 1경기 예상 시간(분)
const ADMIN_PIN = '1234';     // ★ 꼭 바꾸세요 (리셋·아이콘 삭제·모드 변경용)
const KEY = 'STATE_V3';
const EMOJIS = ['🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐨','🐯','🦁','🐮','🐷','🐸','🐵','🐔','🐧','🐤','🦆','🦉','🐴','🦄','🐝','🐢','🐙','🦀','🐬','🐳','🦖','🍎','🍊','🍋','🍉','🍇','🍓','🍍','🥝','🌽','🌻','🌵','⚽','🏀','🚗','🚀','⭐','🌈','🔥','🍀'];

/* GitHub Pages 등 외부 페이지에서 쓰는 JSON API (POST, text/plain) */
const API_FNS = ['getState', 'join', 'leave', 'startNext', 'endGame', 'checkAdmin', 'removeById', 'setMode', 'resetAll'];
function doPost(e) {
  let out;
  try {
    const req = JSON.parse(e.postData.contents);
    if (API_FNS.indexOf(req.fn) < 0) throw new Error('지원하지 않는 요청입니다.');
    out = { ok: true, data: globalThis[req.fn].apply(null, req.args || []) };
  } catch (err) {
    out = { ok: false, error: err.message };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('테니스장 게임 대기판')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/* ---------- 저장/불러오기 ---------- */
function blank_() {
  return {
    mode: 'auto', // auto | weekday | weekend
    courts: [{ id: 1, players: [], start: null }, { id: 2, players: [], start: null }],
    queue: [],    // {id, e(이모지), court(0=통합,1,2), t}
    log: []
  };
}
function load_() {
  const raw = PropertiesService.getScriptProperties().getProperty(KEY);
  return raw ? JSON.parse(raw) : blank_();
}
function save_(s) {
  s.log = s.log.slice(-40);
  PropertiesService.getScriptProperties().setProperty(KEY, JSON.stringify(s));
}
function isWeekend_(s) {
  if (s.mode === 'weekday') return false;
  if (s.mode === 'weekend') return true;
  const d = Number(Utilities.formatDate(new Date(), 'Asia/Seoul', 'u')); // 1=월 … 7=일
  return d >= 6;
}
function log_(s, msg) { s.log.push({ t: Date.now(), msg: msg }); }
function view_(s, extra) {
  const v = {
    now: Date.now(),
    gameMin: GAME_MIN,
    emojis: EMOJIS,
    weekend: isWeekend_(s),
    mode: s.mode,
    courts: s.courts,
    queue: s.queue,
    log: s.log.slice(-12).reverse()
  };
  if (extra) Object.keys(extra).forEach(k => v[k] = extra[k]);
  return v;
}
function mutate_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const s = load_();
    const extra = fn(s);
    save_(s);
    return view_(s, extra);
  } finally {
    lock.releaseLock();
  }
}
function checkPin_(pin) {
  if (String(pin) !== ADMIN_PIN) throw new Error('관리자 PIN이 틀렸습니다.');
}
function es_(arr) { return arr.map(p => p.e).join(' '); }

/* ---------- 화면에서 호출하는 함수 ---------- */
function getState() { return view_(load_()); }

/** 고른 이모지 1~4개 = 인원 수만큼 대기 등록 */
function join(emojis, court) {
  return mutate_(s => {
    emojis = (emojis || []).slice(0, 4);
    if (!emojis.length) throw new Error('이모지를 골라 주세요.');
    const used = inUse_(s);
    emojis.forEach(e => {
      if (EMOJIS.indexOf(e) < 0) throw new Error('사용할 수 없는 아이콘입니다.');
      if (used[e]) throw new Error(e + ' 는 이미 다른 분이 쓰고 있어요. 다른 아이콘을 골라 주세요.');
    });
    const c = isWeekend_(s) ? (Number(court) === 2 ? 2 : 1) : 0;
    const created = emojis.map(e => {
      const q = { id: Utilities.getUuid().slice(0, 8), e: e, court: c, t: Date.now() };
      s.queue.push(q);
      return q.id;
    });
    log_(s, emojis.join(' ') + ' 대기 등록' + (c ? ' (' + c + '코트)' : ''));
    return { created: created };
  });
}
function inUse_(s) {
  const used = {};
  s.queue.forEach(q => used[q.e] = true);
  s.courts.forEach(c => c.players.forEach(p => used[p.e] = true));
  return used;
}

/** 본인 아이콘 취소 (화면에서는 본인 휴대폰에서 등록한 것만 취소 버튼이 보임) */
function leave(id) {
  return mutate_(s => {
    const q = s.queue.find(x => x.id === id);
    if (!q) return;
    s.queue = s.queue.filter(x => x.id !== id);
    log_(s, q.e + ' 대기 취소');
  });
}

/** 해당 코트에 다음 4명 입장 (진행 중 경기가 있으면 종료 처리) */
function startNext(courtId, force) {
  return mutate_(s => {
    const court = s.courts[courtId - 1];
    const list = isWeekend_(s) ? s.queue.filter(q => (q.court || 1) === courtId) : s.queue;
    const take = list.slice(0, 4);
    if (take.length === 0) throw new Error('대기자가 없습니다.');
    if (take.length < 4 && !force) throw new Error('NEED_FORCE');
    const ids = take.map(q => q.id);
    if (court.players.length) log_(s, courtId + '코트 경기 종료');
    s.queue = s.queue.filter(q => ids.indexOf(q.id) < 0);
    court.players = take.map(q => ({ id: q.id, e: q.e }));
    court.start = Date.now();
    log_(s, courtId + '코트 입장: ' + es_(court.players));
  });
}

function endGame(courtId) {
  return mutate_(s => {
    const court = s.courts[courtId - 1];
    if (!court.players.length) return;
    log_(s, courtId + '코트 경기 종료 (' + es_(court.players) + ')');
    court.players = [];
    court.start = null;
  });
}

/* ---------- 관리자 ---------- */
/** 관리자 PIN 확인 */
function checkAdmin(pin) { checkPin_(pin); return true; }

/** 미입장(노쇼) 등 관리자 삭제 */
function removeById(pin, id) {
  checkPin_(pin);
  return mutate_(s => {
    const q = s.queue.find(x => x.id === id);
    if (!q) return;
    s.queue = s.queue.filter(x => x.id !== id);
    log_(s, q.e + ' 관리자 삭제');
  });
}

function setMode(pin, mode) {
  checkPin_(pin);
  return mutate_(s => {
    s.mode = ['auto', 'weekday', 'weekend'].indexOf(mode) >= 0 ? mode : 'auto';
    log_(s, '운영 모드 변경: ' + s.mode);
  });
}

/** 전체 리셋: 코트·대기 모두 비우기 */
function resetAll(pin) {
  checkPin_(pin);
  return mutate_(s => {
    const mode = s.mode;
    const b = blank_();
    Object.keys(b).forEach(k => s[k] = b[k]);
    s.mode = mode;
    log_(s, '전체 리셋');
  });
}

/** (선택) 트리거로 매일 새벽 3시에 실행하면 자동 리셋 */
function dailyReset() {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const s = load_();
    const b = blank_();
    b.mode = s.mode;
    save_(b);
  } finally {
    lock.releaseLock();
  }
}
