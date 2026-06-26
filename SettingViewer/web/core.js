// SettingViewer 순수 로직 모듈 (환경 비의존, vitest 직접 import).
// DOM/fetch/브라우저 전역 미참조. app.js 가 실제 의존성을 주입한다.

const ZOOM_MIN = 1;
const ZOOM_MAX = 36;

/**
 * 정규화 ROI(0~1) → 표시 픽셀 좌표(설계서 §5.2).
 * imgW/imgH = img.clientWidth/clientHeight(표시 크기, naturalWidth 아님).
 */
export function toPixel(rect, imgW, imgH) {
  return { px: rect.x * imgW, py: rect.y * imgH, pw: rect.w * imgW, ph: rect.h * imgH };
}

/** 결합 키 `${camIdx}:${presetIdx}` (ROI/프리셋 매칭). */
export function presetKey(camIdx, presetIdx) {
  return `${camIdx}:${presetIdx}`;
}

/**
 * slot 라벨: globalIndex 에서 slotId 매칭 시 globalIdx, 없으면 slotId 폴백(G3-4).
 * globalIndex: Array<{ globalIdx, slotId, ... }>.
 */
export function slotLabel(slotId, globalIndex) {
  const hit = (globalIndex ?? []).find((g) => g.slotId === slotId);
  return hit ? String(hit.globalIdx) : slotId;
}

/** fps → setInterval 간격(ms). fps=3 → 333. */
export function fpsToInterval(fps) {
  return Math.round(1000 / fps);
}

/** zoom 클램프(1~36). */
export function clampZoom(z, min = ZOOM_MIN, max = ZOOM_MAX) {
  return Math.min(max, Math.max(min, z));
}

/**
 * 방향/스텝 → 절대 PTZ 환산. dir ∈ {'up','down','left','right','zoomIn','zoomOut'}.
 * zoom 은 ±1 단계(클램프), pan/tilt 는 ±step.
 */
export function stepPtz(cur, dir, step) {
  const next = { pan: cur.pan, tilt: cur.tilt, zoom: cur.zoom };
  switch (dir) {
    case 'left':
      next.pan = cur.pan - step;
      break;
    case 'right':
      next.pan = cur.pan + step;
      break;
    case 'up':
      next.tilt = cur.tilt + step;
      break;
    case 'down':
      next.tilt = cur.tilt - step;
      break;
    case 'zoomIn':
      next.zoom = clampZoom(cur.zoom + 1);
      break;
    case 'zoomOut':
      next.zoom = clampZoom(cur.zoom - 1);
      break;
    default:
      break;
  }
  return next;
}

/**
 * 정밀 수집 진행률(설계서 §7.2). done/planned → { percent, label }. 0 division 방어.
 * status: { state, round, done, planned, runId? }.
 */
export function captureProgress(status) {
  const planned = Number(status?.planned ?? 0);
  const done = Number(status?.done ?? 0);
  const percent = planned > 0 ? Math.min(100, Math.round((done / planned) * 100)) : 0;
  const state = status?.state ?? 'idle';
  const label = `${state} ${done}/${planned} (${percent}%)`;
  return { percent, label };
}

/**
 * 체크포인트 자문 매핑(표시 문자열 배열). status.latestAdvisory(서버 산출) 우선,
 * 없으면 빈 배열. (서버 advisoryLines 결과를 그대로 표시 — UI 는 얇게 유지.)
 */
export function mapAdvisory(status) {
  const adv = status?.latestAdvisory;
  return Array.isArray(adv) ? adv.slice() : [];
}

/**
 * 폴링 계획(설계서 §7.2). running/stopping 중에만 폴링 계속(간격 ms).
 * → { poll: boolean, intervalMs }.
 */
export function pollPlan(state, intervalMs = 2000) {
  const poll = state === 'running' || state === 'stopping' || state === 'finalizing';
  return { poll, intervalMs };
}

/** 컨트롤 패널 드래그 리사이즈 폭 클램프(px → [min,max] 정수). */
export function clampPanelWidth(px, min = 260, max = 720) {
  return Math.min(max, Math.max(min, Math.round(px)));
}

/**
 * 스냅샷 폴링 루프(백프레셔·Blob revoke·정지). DOM/브라우저 전역 미참조 → 의존성 주입.
 * deps:
 *   - fetchFn(url, { signal }) → Response(blob() 보유)
 *   - makeUrl(seq) → 요청 URL(매 프레임 t 증가)
 *   - createObjectURL(blob) → string
 *   - revokeObjectURL(url)
 *   - setImage(url) → Promise|void (img.src 교체 + decode)
 *   - onPtz(headers) (선택) 응답 헤더로 현재 PTZ 갱신
 *   - setTimer(fn, ms) → handle / clearTimer(handle) (기본: setInterval/clearInterval)
 */
export function createStreamLoop(deps) {
  const setTimer = deps.setTimer ?? ((fn, ms) => setInterval(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h) => clearInterval(h));

  let seq = 0;
  let inflight = null; // AbortController
  let timer = null;
  let lastUrl = null;

  async function tick() {
    if (inflight) return; // 백프레셔: 이전 요청 진행 중이면 스킵
    const ac = new AbortController();
    inflight = ac;
    try {
      const url = deps.makeUrl(seq++);
      const res = await deps.fetchFn(url, { signal: ac.signal });
      const blob = await res.blob();
      const nextUrl = deps.createObjectURL(blob);
      await deps.setImage(nextUrl);
      if (lastUrl) deps.revokeObjectURL(lastUrl); // 이전 Blob URL 해제(누수 방지, G3-4)
      lastUrl = nextUrl;
      if (deps.onPtz) deps.onPtz(res.headers);
    } catch {
      // abort/timeout/decode 실패 무시
    } finally {
      inflight = null;
    }
  }

  function start(fps) {
    if (timer) return;
    timer = setTimer(tick, fpsToInterval(fps));
  }

  function stop() {
    if (timer) {
      clearTimer(timer);
      timer = null;
    }
    if (inflight) {
      inflight.abort();
      inflight = null;
    }
  }

  return { start, stop, tick };
}
