/**
 * 치동천테니스클럽 게임 대기판 — Google Apps Script 서버
 * - 이름 없이 이모지로만 운영 (개인정보 저장 안 함)
 * - 입력은 매일 06:00~10:00만 가능, 날짜가 바뀌면 자동으로 새 하루 시작
 * - 배포: 배포 > 새 배포 > 웹 앱 / 실행: 나 / 액세스: 모든 사용자
 */
const ADMIN_PIN = '1234';     // ★ Apps Script에서 꼭 바꾸세요 (GitHub에는 올리지 마세요)
const KEY = 'STATE_V4';
const TZ = 'Asia/Seoul';

function ctx_(dev) {
  const d = new Date();
  return {
    now: d.getTime(),
    day: Utilities.formatDate(d, TZ, 'yyyy-MM-dd'),
    hour: Number(Utilities.formatDate(d, TZ, 'H')),
    mod: Number(Utilities.formatDate(d, TZ, 'H')) * 60 + Number(Utilities.formatDate(d, TZ, 'm')),
    dow: Number(Utilities.formatDate(d, TZ, 'u')),
    uuid: () => Utilities.getUuid().slice(0, 8),
    dev: dev ? String(dev).slice(0, 20) : ''
  };
}
function load_() {
  const raw = PropertiesService.getScriptProperties().getProperty(KEY);
  return raw ? JSON.parse(raw) : core_blank();
}
function save_(s) { PropertiesService.getScriptProperties().setProperty(KEY, JSON.stringify(s)); }

/** 화면에서 부르는 단일 창구: api('join', [...], pin, deviceId) */
function api(op, args, pin, dev) {
  const ctx = ctx_(dev);
  if (op === 'getState') {
    const s = load_();
    const before = JSON.stringify(s);
    const v = core_run(s, ctx, op, args, false);
    if (JSON.stringify(s) !== before) withLock_(() => { const t = load_(); core_rollDay(t, ctx); core_expire(t, ctx); save_(t); });
    return v;
  }
  return withLock_(() => {
    const s = load_();
    const v = core_run(s, ctx, op, args, String(pin || '') === ADMIN_PIN);
    save_(s);
    return v;
  });
}
function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try { return fn(); } finally { lock.releaseLock(); }
}

/* GitHub Pages에서 부르는 JSON API (POST, text/plain) */
function doPost(e) {
  let out;
  try {
    const r = JSON.parse(e.postData.contents);
    out = { ok: true, data: api(r.op, r.args, r.pin, r.dev) };
  } catch (err) {
    out = { ok: false, error: err.message };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

/* Apps Script 주소로 직접 열 때 */
function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('치동천테니스클럽 게임 대기판')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/* ===== 공통 로직 (서버 Code.gs와 미리보기가 같은 코드를 씀) ===== */
const GAME_MIN = 30;      // 1경기 예상 시간(분)
const OPEN_HOUR = 6;      // 입력 가능 시작 (06:00)
const CLOSE_HOUR = 10;    // 입력 가능 종료 (10:00)
const BONUS_MIN = 15;     // 정시 도착 혜택: 15분 먼저 온 것으로 인정
const EARLY_MIN = 15, LATE_MIN = 10;  // 정시 도착 인정 범위: 예정 시각 15분 전 ~ 10분 후
const MAX_TEAMS = 5;      // 대기 가능 최대 5팀(20명) — 경기에 들어가면 그만큼 자리가 다시 생김
const EXPIRE_MIN = 30;    // 예정 시각 30분이 지나도 안 오면 예정 자동 삭제
const EMOJIS = ['🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐨','🐯','🦁','🐮','🐷','🐸','🐵','🐔','🐧','🐤','🦆','🦉','🐴','🦄','🐝','🐢','🐙','🦀','🐬','🐳','🦖','🍎','🍊','🍋','🍉','🍇','🍓','🍍','🥝','🌽','🌻','🌵','⚽','🏀','🚗','🚀','⭐','🌈','🔥','🍀'];
const USER_OPS = ['join', 'leave', 'move', 'setName', 'addPlan', 'cancelPlan', 'arrive', 'startNext', 'endGame'];
const ADMIN_OPS = ['checkAdmin', 'setMode', 'resetAll'];

function core_blank(mode) {
  return {
    mode: mode || 'auto', // auto | weekday | weekend
    day: '',
    courts: [{ id: 1, players: [], start: null }, { id: 2, players: [], start: null }],
    queue: [],   // 코트에 와서 대기 중 {id, e, court(0=통합,1,2), t}
    plans: [],   // 도착 예정 {id, e, eta:'HH:mm', t, dev, nobonus}
    banned: [],  // 오늘 지각·노쇼한 기기 → 오늘은 정시 도착 혜택 없음
    log: []
  };
}
/** 날짜가 바뀌면 자동으로 새 하루 시작 */
function core_rollDay(s, ctx) {
  if (!s.plans) s.plans = [];
  if (!s.banned) s.banned = [];
  if (s.day !== ctx.day) {
    const mode = s.mode;
    Object.assign(s, core_blank(mode));
    s.day = ctx.day;
  }
}
function core_isWeekend(s, ctx) {
  if (s.mode === 'weekday') return false;
  if (s.mode === 'weekend') return true;
  return ctx.dow >= 6; // 1=월 … 7=일
}
function core_isOpen(ctx) { return ctx.hour >= OPEN_HOUR && ctx.hour < CLOSE_HOUR; }
function core_log(s, ctx, msg) { s.log.push({ t: ctx.now, msg: msg }); s.log = s.log.slice(-40); }
function core_inUse(s) {
  const u = {};
  s.queue.forEach(q => u[q.e] = true);
  s.plans.forEach(q => u[q.e] = true);
  s.courts.forEach(c => c.players.forEach(p => u[p.e] = true));
  return u;
}
function core_checkEmojis(s, emojis) {
  emojis = (emojis || []).slice(0, 1);   // 본인 1명만
  if (!emojis.length) throw new Error('아이콘을 골라 주세요.');
  const used = core_inUse(s);
  emojis.forEach(e => {
    if (EMOJIS.indexOf(e) < 0) throw new Error('사용할 수 없는 아이콘이에요.');
    if (used[e]) throw new Error(e + ' 는 이미 다른 분이 쓰고 있어요. 다른 아이콘을 골라 주세요.');
  });
  return emojis;
}
/** 남은 대기 자리 (평일: 대기+도착예정 합계 20명 / 주말: 코트별 20명, 도착예정은 전체에서 차감) */
function core_free(s, ctx, court) {
  const cap = MAX_TEAMS * 4;
  if (!core_isWeekend(s, ctx)) return cap - s.queue.length - s.plans.length;
  const inLine = s.queue.filter(q => (q.court || 1) === court).length;
  return Math.min(cap - inLine, cap * 2 - s.queue.length - s.plans.length);
}
function core_needRoom(s, ctx, court, n, isArrival) {
  const free = core_free(s, ctx, court) + (isArrival && !core_isWeekend(s, ctx) ? n : 0);
  if (free < n) throw new Error(free <= 0 ? '대기가 가득 찼어요 (최대 ' + MAX_TEAMS + '팀). 다음 팀이 입장하면 자리가 생겨요.'
    : '남은 대기 자리가 ' + free + '명뿐이에요.');
}
/** 한 휴대폰에 하나만 (본인 것만 기록) */
function core_oneDev(s, dev) {
  if (!dev) return;
  if (s.queue.some(q => q.dev === dev) || s.plans.some(p => p.dev === dev)) throw new Error('이미 등록돼 있어요. 한 사람당 하나만 등록할 수 있어요.');
}
function core_view(s, ctx, extra) {
  const v = {
    now: ctx.now, gameMin: GAME_MIN, maxTeams: MAX_TEAMS,
    free: core_isWeekend(s, ctx) ? { 1: core_free(s, ctx, 1), 2: core_free(s, ctx, 2) } : { 0: core_free(s, ctx, 0) }, bonusMin: BONUS_MIN, earlyMin: EARLY_MIN, lateMin: LATE_MIN, expireMin: EXPIRE_MIN, openHour: OPEN_HOUR, closeHour: CLOSE_HOUR,
    open: core_isOpen(ctx), emojis: EMOJIS, weekend: core_isWeekend(s, ctx), mode: s.mode,
    courts: s.courts.map(c => ({ id: c.id, start: c.start, players: c.players.map(p => ({ id: p.id, e: p.e, nm: p.nm || '' })) })),
    queue: s.queue.map(q => ({ id: q.id, e: q.e, nm: q.nm || '', court: q.court, t: q.t, bonus: q.bonus })), plans: s.plans.map(p => ({ id: p.id, e: p.e, nm: p.nm || '', eta: p.eta, t: p.t, nobonus: p.nobonus })), log: s.log.slice(-15).reverse()
  };
  if (ctx.dev) v.banned = s.banned.indexOf(ctx.dev) >= 0;
  if (extra) Object.keys(extra).forEach(k => v[k] = extra[k]);
  return v;
}
const es_ = arr => arr.map(p => p.e).join(' ');
/** 선택 이름: 공백 정리, 8자 제한, 꺾쇠 제거 (안 쓰면 아이콘만) */
function core_name(n) { return String(n || '').replace(/[<>&"'`]/g, '').replace(/\s+/g, ' ').trim().slice(0, 8); }

const CoreOps = {
  /** 지금 코트에 와서 대기 등록 (아이콘 1~4개 = 인원) */
  join(s, ctx, emojis, court, names, dev) {
    emojis = core_checkEmojis(s, emojis); names = names || [];
    dev = String(dev || '').slice(0, 20); core_oneDev(s, dev);
    const c = core_isWeekend(s, ctx) ? (Number(court) === 2 ? 2 : 1) : 0;
    core_needRoom(s, ctx, c || 1, emojis.length, false);
    const created = emojis.map((e, i) => { const q = { id: ctx.uuid(), e: e, nm: core_name(names[i]), court: c, t: ctx.now, vt: ctx.now, dev: dev }; s.queue.push(q); return q.id; });
    core_log(s, ctx, emojis.join(' ') + ' 대기 등록' + (c ? ' (' + c + '코트)' : ''));
    return { created: created };
  },
  /** 대기에서 빠짐 (누구나 — 중간에 빠지는 사람 정리) */
  leave(s, ctx, id) {
    const q = s.queue.find(x => x.id === id);
    if (!q) return;
    s.queue = s.queue.filter(x => x.id !== id);
    core_log(s, ctx, q.e + ' 대기에서 빠짐');
  },
  /** 순서 수정: up = 앞 게임으로, down = 다음 게임으로, end = 맨 뒤로 */
  move(s, ctx, id, how) {
    const q = s.queue.find(x => x.id === id);
    if (!q) throw new Error('이미 대기 명단에 없어요.');
    const weekend = core_isWeekend(s, ctx);
    const line = weekend ? s.queue.filter(x => (x.court || 1) === (q.court || 1)) : s.queue.slice();
    const idx = line.indexOf(q);
    const others = line.filter(x => x !== q);
    let to = how === 'up' ? Math.max(0, Math.floor(idx / 4) * 4 - 4 + 3) : how === 'down' ? (Math.floor(idx / 4) + 1) * 4 : others.length;
    if (how === 'up' && idx < 4) throw new Error('이미 다음 게임이에요.');
    to = Math.min(to, others.length);
    s.queue = s.queue.filter(x => x !== q);
    if (to >= others.length) {
      const last = others[others.length - 1];
      const at = last ? s.queue.indexOf(last) + 1 : s.queue.length;
      s.queue.splice(at, 0, q);
    } else {
      s.queue.splice(s.queue.indexOf(others[to]), 0, q);
    }
    core_log(s, ctx, q.e + (how === 'up' ? ' 앞 게임으로 이동' : how === 'down' ? ' 다음 게임으로 미룸' : ' 맨 뒤로 이동'));
  },
  /** 이름 표시 바꾸기 (빈칸이면 아이콘만) */
  setName(s, ctx, id, name) {
    const q = s.queue.find(x => x.id === id) || s.plans.find(x => x.id === id);
    if (!q) throw new Error('명단에 없어요.');
    q.nm = core_name(name);
  },
  /** 도착 예정 등록 */
  addPlan(s, ctx, emojis, eta, dev, names) {
    emojis = core_checkEmojis(s, emojis); names = names || [];
    if (!/^\d{2}:\d{2}$/.test(String(eta))) throw new Error('도착 시간을 골라 주세요.');
    const m = core_hm(eta);
    if (m < ctx.mod - 5 || m >= CLOSE_HOUR * 60) throw new Error('도착 시간은 지금부터 ' + CLOSE_HOUR + ':00 전까지 고를 수 있어요.');
    if (core_isWeekend(s, ctx)) { if (MAX_TEAMS * 8 - s.queue.length - s.plans.length < emojis.length) throw new Error('대기가 가득 찼어요.'); }
    else core_needRoom(s, ctx, 0, emojis.length, false);
    dev = String(dev || '').slice(0, 20); core_oneDev(s, dev);
    const nobonus = !!dev && s.banned.indexOf(dev) >= 0;
    const created = emojis.map((e, i) => { const p = { id: ctx.uuid(), e: e, nm: core_name(names[i]), eta: eta, t: ctx.now, dev: dev, nobonus: nobonus }; s.plans.push(p); return p.id; });
    s.plans.sort((a, b) => a.eta < b.eta ? -1 : a.eta > b.eta ? 1 : a.t - b.t);
    core_log(s, ctx, emojis.join(' ') + ' ' + eta + ' 도착 예정' + (nobonus ? ' (오늘 혜택 제외)' : ''));
    return { created: created, nobonus: nobonus };
  },
  cancelPlan(s, ctx, id) {
    const p = s.plans.find(x => x.id === id);
    if (!p) return;
    s.plans = s.plans.filter(x => x.id !== id);
    const late = ctx.mod - core_hm(p.eta) > LATE_MIN;
    if (late) core_ban(s, p);
    core_log(s, ctx, p.e + ' 도착 예정 취소' + (late ? ' (시간 지남 — 오늘 혜택 제외)' : ''));
  },
  /** 도착 → 대기 등록. 예정 시간에 맞춰 오면 15분 먼저 온 것으로 쳐서 앞쪽에 넣어 줌
   *  (단, 바로 다음 게임 4명은 건드리지 않음) */
  arrive(s, ctx, ids, court) {
    const c = core_isWeekend(s, ctx) ? (Number(court) === 2 ? 2 : 1) : 0;
    const ps = s.plans.filter(x => ids.indexOf(x.id) >= 0);
    if (!ps.length) throw new Error('도착 예정 명단에 없어요.');
    if (c) { const inLine = s.queue.filter(q => (q.court || 1) === c).length; if (MAX_TEAMS * 4 - inLine < ps.length) throw new Error(c + '코트 대기가 가득 찼어요. 다른 코트를 골라 주세요.'); }
    s.plans = s.plans.filter(x => ids.indexOf(x.id) < 0);
    const onTime = ps.every(p => core_onTime(p, ctx));
    const late = ps.some(p => ctx.mod - core_hm(p.eta) > LATE_MIN);
    if (late) ps.forEach(p => core_ban(s, p));
    const vt = onTime ? ctx.now - BONUS_MIN * 60000 : ctx.now;
    const line = c ? s.queue.filter(q => (q.court || 1) === c) : s.queue;
    let anchor = null;
    if (onTime) for (let i = 4; i < line.length; i++) { if ((line[i].vt || line[i].t) > vt) { anchor = line[i]; break; } }
    const items = ps.map(p => ({ id: p.id, e: p.e, nm: p.nm || '', dev: p.dev, court: c, t: ctx.now, vt: vt, bonus: onTime }));
    if (anchor) s.queue.splice(s.queue.indexOf(anchor), 0, ...items);
    else items.forEach(q => s.queue.push(q));
    core_log(s, ctx, es_(ps) + (onTime ? ' 정시 도착 ⏰ (' + BONUS_MIN + '분 우선)' : late ? ' 지각 도착 — 일반 대기, 오늘 혜택 제외' : ' 도착 · 대기 등록'));
    return { onTime: onTime, jumped: !!anchor, late: late };
  },
  /** 다음 4명 입장 (진행 중 경기는 종료 처리) */
  startNext(s, ctx, courtId, force) {
    const court = s.courts[courtId - 1];
    const line = core_isWeekend(s, ctx) ? s.queue.filter(q => (q.court || 1) === courtId) : s.queue;
    const take = line.slice(0, 4);
    if (!take.length) throw new Error('대기자가 없어요.');
    if (take.length < 4 && !force) throw new Error('NEED_FORCE');
    const ids = take.map(q => q.id);
    if (court.players.length) core_log(s, ctx, courtId + '코트 경기 종료');
    s.queue = s.queue.filter(q => ids.indexOf(q.id) < 0);
    court.players = take.map(q => ({ id: q.id, e: q.e, nm: q.nm || '' }));
    court.start = ctx.now;
    core_log(s, ctx, courtId + '코트 입장: ' + es_(court.players));
  },
  endGame(s, ctx, courtId) {
    const court = s.courts[courtId - 1];
    if (!court.players.length) return;
    core_log(s, ctx, courtId + '코트 경기 종료 (' + es_(court.players) + ')');
    court.players = []; court.start = null;
  },
  /* 관리자 */
  checkAdmin() { return {}; },
  setMode(s, ctx, mode) {
    s.mode = ['auto', 'weekday', 'weekend'].indexOf(mode) >= 0 ? mode : 'auto';
    core_log(s, ctx, '운영 방식 변경');
  },
  resetAll(s, ctx) {
    const mode = s.mode, day = s.day;
    Object.assign(s, core_blank(mode)); s.day = day;
    core_log(s, ctx, '전체 리셋');
  }
};

/** 모든 요청의 공통 처리 */
function core_hm(t) { const a = String(t).split(':'); return (+a[0]) * 60 + (+a[1]); }
function core_onTime(p, ctx) { const d = ctx.mod - core_hm(p.eta); return !p.nobonus && d >= -EARLY_MIN && d <= LATE_MIN; }
function core_ban(s, p) { if (p.dev && s.banned.indexOf(p.dev) < 0) s.banned.push(p.dev); }
function core_expire(s, ctx) {
  const gone = s.plans.filter(p => ctx.mod - core_hm(p.eta) > EXPIRE_MIN);
  if (gone.length) {
    s.plans = s.plans.filter(p => gone.indexOf(p) < 0);
    gone.forEach(p => core_ban(s, p));
    core_log(s, ctx, es_(gone) + ' 노쇼 — 예정 자동 삭제, 오늘 혜택 제외');
  }
  return gone.length > 0;
}
function core_run(s, ctx, op, args, pinOk) {
  core_rollDay(s, ctx);
  core_expire(s, ctx);
  if (ADMIN_OPS.indexOf(op) >= 0) {
    if (!pinOk) throw new Error('관리자 PIN이 틀렸어요.');
  } else if (USER_OPS.indexOf(op) >= 0) {
    if (!core_isOpen(ctx)) throw new Error('입력은 매일 0' + OPEN_HOUR + ':00 ~ ' + CLOSE_HOUR + ':00에만 할 수 있어요.');
  } else if (op !== 'getState') {
    throw new Error('지원하지 않는 요청이에요.');
  }
  const extra = op === 'getState' ? null : CoreOps[op].apply(null, [s, ctx].concat(args || []));
  return core_view(s, ctx, extra);
}
