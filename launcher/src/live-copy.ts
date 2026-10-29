import type { Language, LiveStatusItem } from "./types";

const en = {
  title: "Live status",
  updated: "Updated {time} ago",
  justNow: "Updated just now",
  stale: "No update for {time}",
  checking: "Checking…",
  bridge: "Bridge",
  chatgpt: "ChatGPT",
  route: "Codex route",
  mcp: "MCP",
  longrun: "Long runs",
  bridgeOk: "Running",
  bridgeBusy: "Working · {count} active",
  bridgeError: "Not reachable on port {port}",
  bridgeDraining: "Finishing current turns",
  bridgeOff: "Not set up",
  chatgptOk: "Signed in",
  chatgptBusy: "Working",
  chatgptLoading: "Loading",
  chatgptSignedOut: "Sign in needed",
  chatgptError: "Needs attention",
  chatgptOff: "Starting",
  routeOk: "Codex uses ChatGPT web",
  routeWarn: "Codex is not routed here",
  routeOther: "Codex uses another route",
  routeOff: "No Codex config found",
  mcpOk: "Runtime running",
  mcpUnverified: "Runtime running · connector not verified",
  mcpError: "Runtime not running",
  mcpOff: "Not enabled",
  longrunOk: "Hooks active",
  longrunLast: "Hooks active · last: {event}, {time} ago",
  longrunBusy: "Working · {event}",
  longrunMissing: "Hooks not installed",
  longrunStale: "Hooks need Reinstall",
  longrunDamaged: "Hooks damaged · Reinstall",
  longrunOff: "No Codex config found",
};

export type LiveCopy = { [Key in keyof typeof en]: string };

const zhCN: LiveCopy = {
  title: "实时状态",
  updated: "{time}前更新",
  justNow: "刚刚更新",
  stale: "已 {time} 未更新",
  checking: "正在检查…",
  bridge: "桥接",
  chatgpt: "ChatGPT",
  route: "Codex 路由",
  mcp: "MCP",
  longrun: "长任务",
  bridgeOk: "运行中",
  bridgeBusy: "工作中 · {count} 个进行中",
  bridgeError: "端口 {port} 无法访问",
  bridgeDraining: "正在完成当前任务",
  bridgeOff: "未设置",
  chatgptOk: "已登录",
  chatgptBusy: "工作中",
  chatgptLoading: "加载中",
  chatgptSignedOut: "需要登录",
  chatgptError: "需要处理",
  chatgptOff: "正在启动",
  routeOk: "Codex 使用 ChatGPT 网页版",
  routeWarn: "Codex 未路由到此处",
  routeOther: "Codex 使用其他路由",
  routeOff: "未找到 Codex 配置",
  mcpOk: "运行时正在运行",
  mcpUnverified: "运行时正在运行 · 连接器未验证",
  mcpError: "运行时未运行",
  mcpOff: "未启用",
  longrunOk: "钩子已启用",
  longrunLast: "钩子已启用 · 最近：{event}，{time}前",
  longrunBusy: "工作中 · {event}",
  longrunMissing: "钩子未安装",
  longrunStale: "钩子需要重新安装",
  longrunDamaged: "钩子已损坏 · 请重新安装",
  longrunOff: "未找到 Codex 配置",
};

const zhTW: LiveCopy = {
  title: "即時狀態",
  updated: "{time}前更新",
  justNow: "剛剛更新",
  stale: "已 {time} 未更新",
  checking: "正在檢查…",
  bridge: "橋接",
  chatgpt: "ChatGPT",
  route: "Codex 路由",
  mcp: "MCP",
  longrun: "長時間任務",
  bridgeOk: "執行中",
  bridgeBusy: "工作中 · {count} 個進行中",
  bridgeError: "連接埠 {port} 無法連線",
  bridgeDraining: "正在完成目前任務",
  bridgeOff: "尚未設定",
  chatgptOk: "已登入",
  chatgptBusy: "工作中",
  chatgptLoading: "載入中",
  chatgptSignedOut: "需要登入",
  chatgptError: "需要處理",
  chatgptOff: "正在啟動",
  routeOk: "Codex 使用 ChatGPT 網頁版",
  routeWarn: "Codex 未路由到此處",
  routeOther: "Codex 使用其他路由",
  routeOff: "找不到 Codex 設定",
  mcpOk: "執行階段正在執行",
  mcpUnverified: "執行階段正在執行 · 連接器未驗證",
  mcpError: "執行階段未執行",
  mcpOff: "未啟用",
  longrunOk: "掛鉤已啟用",
  longrunLast: "掛鉤已啟用 · 最近：{event}，{time}前",
  longrunBusy: "工作中 · {event}",
  longrunMissing: "掛鉤未安裝",
  longrunStale: "掛鉤需要重新安裝",
  longrunDamaged: "掛鉤已損毀 · 請重新安裝",
  longrunOff: "找不到 Codex 設定",
};

const ja: LiveCopy = {
  title: "ライブ状態",
  updated: "{time}前に更新",
  justNow: "たった今更新",
  stale: "{time}間更新なし",
  checking: "確認中…",
  bridge: "ブリッジ",
  chatgpt: "ChatGPT",
  route: "Codex ルート",
  mcp: "MCP",
  longrun: "長時間タスク",
  bridgeOk: "稼働中",
  bridgeBusy: "処理中 · {count} 件",
  bridgeError: "ポート {port} に接続できません",
  bridgeDraining: "実行中のターンを完了中",
  bridgeOff: "未設定",
  chatgptOk: "サインイン済み",
  chatgptBusy: "処理中",
  chatgptLoading: "読み込み中",
  chatgptSignedOut: "サインインが必要",
  chatgptError: "要確認",
  chatgptOff: "起動中",
  routeOk: "Codex は ChatGPT Web を使用中",
  routeWarn: "Codex はここにルーティングされていません",
  routeOther: "Codex は別のルートを使用中",
  routeOff: "Codex の設定が見つかりません",
  mcpOk: "ランタイム稼働中",
  mcpUnverified: "ランタイム稼働中 · コネクタ未確認",
  mcpError: "ランタイムが停止中",
  mcpOff: "無効",
  longrunOk: "フック有効",
  longrunLast: "フック有効 · 直近: {event}、{time}前",
  longrunBusy: "処理中 · {event}",
  longrunMissing: "フック未インストール",
  longrunStale: "フックの再インストールが必要",
  longrunDamaged: "フックが破損 · 再インストールしてください",
  longrunOff: "Codex の設定が見つかりません",
};

const ko: LiveCopy = {
  title: "실시간 상태",
  updated: "{time} 전 업데이트",
  justNow: "방금 업데이트",
  stale: "{time} 동안 업데이트 없음",
  checking: "확인 중…",
  bridge: "브리지",
  chatgpt: "ChatGPT",
  route: "Codex 경로",
  mcp: "MCP",
  longrun: "장시간 작업",
  bridgeOk: "실행 중",
  bridgeBusy: "작업 중 · {count}개 진행",
  bridgeError: "포트 {port}에 연결할 수 없음",
  bridgeDraining: "진행 중인 턴을 마무리하는 중",
  bridgeOff: "설정되지 않음",
  chatgptOk: "로그인됨",
  chatgptBusy: "작업 중",
  chatgptLoading: "불러오는 중",
  chatgptSignedOut: "로그인 필요",
  chatgptError: "확인 필요",
  chatgptOff: "시작 중",
  routeOk: "Codex가 ChatGPT 웹을 사용 중",
  routeWarn: "Codex가 이곳으로 연결되지 않음",
  routeOther: "Codex가 다른 경로를 사용 중",
  routeOff: "Codex 설정을 찾을 수 없음",
  mcpOk: "런타임 실행 중",
  mcpUnverified: "런타임 실행 중 · 커넥터 미확인",
  mcpError: "런타임이 실행되지 않음",
  mcpOff: "사용 안 함",
  longrunOk: "훅 활성",
  longrunLast: "훅 활성 · 최근: {event}, {time} 전",
  longrunBusy: "작업 중 · {event}",
  longrunMissing: "훅이 설치되지 않음",
  longrunStale: "훅 재설치 필요",
  longrunDamaged: "훅 손상 · 재설치하세요",
  longrunOff: "Codex 설정을 찾을 수 없음",
};

const copies: Record<Language, LiveCopy> = { en, "zh-CN": zhCN, "zh-TW": zhTW, ja, ko };

export function liveCopyFor(language: Language): LiveCopy {
  return copies[language] ?? en;
}

export function liveDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

const fill = (template: string, values: Record<string, string | number>): string => template
  .replace(/\{(\w+)\}/g, (_match, key: string) => String(values[key] ?? ""));

const eventLabel = (event: unknown): string => typeof event === "string" ? event.replace(/_/g, " ") : "";

export function liveItemLabel(item: LiveStatusItem, copy: LiveCopy): string {
  return copy[item.id];
}

// Turns one probe result into the line shown beside its dot. Facts are plain data from the probes,
// never user text, so every sentence comes from the copy table and stays translatable.
export function liveItemText(item: LiveStatusItem, copy: LiveCopy, now: number): string {
  const facts = item.facts;
  const reason = typeof facts.reason === "string" ? facts.reason : "";
  switch (item.id) {
    case "bridge":
      if (item.tone === "ok") return copy.bridgeOk;
      if (item.tone === "busy") return fill(copy.bridgeBusy, { count: (Number(facts.turns) || 0) + (Number(facts.browserTurns) || 0) });
      if (reason === "draining") return copy.bridgeDraining;
      if (item.tone === "error") return fill(copy.bridgeError, { port: String(facts.port ?? "") });
      return copy.bridgeOff;
    case "chatgpt":
      if (item.tone === "ok") return copy.chatgptOk;
      if (item.tone === "busy") return reason === "loading" ? copy.chatgptLoading : copy.chatgptBusy;
      if (reason === "signed-out") return copy.chatgptSignedOut;
      if (item.tone === "error") return copy.chatgptError;
      return copy.chatgptOff;
    case "route":
      if (item.tone === "ok") return copy.routeOk;
      if (reason === "other-route") return copy.routeOther;
      if (item.tone === "warn") return copy.routeWarn;
      return copy.routeOff;
    case "mcp":
      if (item.tone === "ok") return facts.connectorVerified === true ? copy.mcpOk : copy.mcpUnverified;
      if (item.tone === "error") return copy.mcpError;
      return copy.mcpOff;
    case "longrun": {
      const event = eventLabel(facts.event);
      if (item.tone === "busy") return fill(copy.longrunBusy, { event });
      if (item.tone === "ok") {
        const at = Number(facts.at);
        return event && Number.isFinite(at) ? fill(copy.longrunLast, { event, time: liveDuration(now - at) }) : copy.longrunOk;
      }
      if (reason === "stale") return copy.longrunStale;
      if (reason === "damaged") return copy.longrunDamaged;
      if (item.tone === "warn") return copy.longrunMissing;
      return copy.longrunOff;
    }
  }
}

export function liveAgeText(ageMs: number | null, stale: boolean, copy: LiveCopy): string {
  if (ageMs === null) return copy.checking;
  if (stale) return fill(copy.stale, { time: liveDuration(ageMs) });
  return ageMs < 4_000 ? copy.justNow : fill(copy.updated, { time: liveDuration(ageMs) });
}
