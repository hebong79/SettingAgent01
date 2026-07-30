# 16회차 구현 보고 — 뷰어 「도색선 자동검출」 UI 배선 (구현자)

- 작성: 2026-07-29 / 구현자(developer)
- 근거 지시: 리더 확정 설계(프롬프트 내 §1~§4) · `src/rpc/services/roiAuto.ts` · `src/rpc/routes.ts` · `web/app.js`
- 성격: **UI 배선 전용.** 검출 알고리즘·서비스·설정 **무변경**
- 실행 모드: goal/loop B — 성공 판정은 **마스터 육안 확인**이며, 여기까지는 그 준비다

> **Goal**: 마스터가 뷰어에서 버튼 하나로 도색선 자동검출을 실행하고, 결과 주차면이 화면에 그려지며, 면별 점수를 눈으로 확인할 수 있다.

---

## 1. 변경 파일

| 파일 | 상태 | 규모 | 이유 |
|---|---|---|---|
| `web/autoPaint.js` | **신규** | 133줄 | `roi.auto.detect`/`score` 응답 → 그릴 목록·라벨·요약 변환(**순수 ESM**). vitest 가 직접 import 하는 구조를 위해 app.js 밖으로 뺐다(`core.js`·`placeDraw.js` 관례) |
| `web/autoPaint.d.ts` | **신규** | 68줄 | 위 모듈의 타입 선언. `test/**` 가 tsconfig include 안이라 `.d.ts` 짝이 없으면 `tsc` 가 깨진다(`placeDraw.d.ts` 관례) |
| `web/app.js` | **수정** | **+140 / −0** | 렌더 레이어 1개(`drawAutoPaint`) · RPC 헬퍼 1개(`settingRpc`) · 패널 로직(`apRun` 등) · 결선 3줄 |
| `web/index.html` | **수정** | **+33 / −0** | 토글 1개 + 신규 `<section class="panel-section">` 1개 |
| `test/autoPaint.test.ts` | **신규** | 36 테스트 | 순수 변환 + 회귀 0 정적 봉인 + 파괴적 동작 미배선 봉인 |

**무변경 확인**: `src/ground/*` · `src/rpc/services/roiAuto.ts` · `src/config/*` · `config/*.json` · 정본 `data/Place01/PtzCamRoi.json` · DB — 한 바이트도 손대지 않았다.
(정본 최종수정 시각 `2026-07-29 10:01:04`, 본 작업 시작은 18:20 이후 → **작업 중 정본 쓰기 0**을 시각으로 확인.)

> 참고: `git status` 에 보이는 `config/llm.config.json`·`config/tools.config.json`·`src/config/*`·`src/rpc/methods.ts` 변경은
> **내 작업이 아니다** — 세션 시작 스냅샷에 이미 있었거나 동시 진행 중인 다른 작업(`dev-secret`)의 산출이다.

---

## 2. 신규 엘리먼트 id 목록 (8개)

| id | 종류 | 역할 |
|---|---|---|
| `roi-autopaint` | checkbox (상단 토글바) | 시안 레이어 표시. **기본 off** — 회귀 0의 조건 |
| `ap-target` | span | 대상 표시. **현재 화면의 `cam:preset`** 을 자동 사용한다는 사실을 보이게 함(별도 입력 없음) |
| `ap-detect` | button | 「검출」 → `roi.auto.detect` |
| `ap-score` | button | 「검출 + 채점」 → `roi.auto.score` |
| `ap-consensus` | checkbox | 「다시점 합의」. **기본 off**. 툴팁에 `off ≈ 12초 / on ≈ 70초 — 6시점 촬영` 명시 |
| `ap-msg` | div | 진행 표시 + 결과 요약 |
| `ap-issues-box` | details | issues 접이식(결과 없으면 `hidden`) |
| `ap-issues` | div | issues 본문(프리셋별 목록) |

배치: 토글은 상단 `roi-toggles` 의 `#roi-auto` 와 `#roi-cuboid` 사이, 패널은 **「지면 격자 (자동 바닥 ROI)」 섹션 바로 아래**.

---

## 3. RPC 헬퍼를 새로 만든 이유

기존 `callRpc`(app.js)는 `api('/rpc')` = **`/viewer/api/rpc`** 로 간다. 이것은 **Unity 프록시**이며 옵션탭 RPC 콘솔 전용이다.
`roi.auto.*` 는 **SettingAgent 자신의 RPC 평면**(루트 `/rpc`, `src/rpc/routes.ts:30`)에 등록돼 있다. **경로가 다르다.**
`callRpc` 를 고치면 Unity 콘솔이 그대로 깨지므로 건드리지 않고 `settingRpc` 하나를 더 뒀다.

```js
async function settingRpc(method, params) {
  const res = await mutFetch('/rpc', { ... body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params: params ?? {} }) });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, result: data.result ?? null, error: data.error ?? null };
}
```

- **인증**: 기존 규약 그대로 `mutFetch`(`web/token.js`) 사용 → `x-viewer-token` 자동 부착.
  `roi.auto.detect/score` 는 `mutating:false` 라 토큰 게이트를 안 타지만, **POST 는 전부 mutFetch** 라는 웹 규약(`test/webTokenWiring.test.ts` 가 정적 봉인)을 지켰다. 생 `fetch` 로 썼으면 그 테스트가 즉시 실패한다.
- **JSON-RPC 2.0**: `dispatchRpc` 가 `jsonrpc:"2.0"` 를 요구하고(`dispatch.ts:78`), 오류는 HTTP 200 + `error` 필드로 온다. 그래서 `res.ok` 가 아니라 `data.error` 로 분기한다.
- **`consensus` 는 항상 명시 전송**한다. 서버 스키마 기본값이 **true**(`roiAuto.ts:61`)라, 체크 해제 상태에서 필드를 빼면 **사용자 의도와 정반대로 70초짜리 6시점 촬영이 돈다.**

---

## 4. 회귀 0 논증 (3중)

### (가) 구조 — 순수 가산 diff, 기존 줄 **0줄** 변경
```
git diff --numstat -- web/app.js web/index.html
140  0  web/app.js
 33  0  web/index.html
```
**삭제·수정된 기존 줄이 하나도 없다.** 기존 렌더 함수(`drawFileFloorRoi`·`drawAutoRoi`·`drawDetectOverlay`·`drawCuboidOverlay`·`drawOccupancyOverlay`)의 본문·호출 순서·색·좌표 계산이 전부 그대로다.

### (나) 조기 return — off 면 캔버스에 아무것도 안 그린다
`drawAutoPaint` 의 **첫 문장**이 게이트다.
```js
if (!$('roi-autopaint')?.checked || !state.autoPaint) return;
```
- 토글은 `index.html` 에서 **`checked` 속성 없음** = 기본 off.
- 호출 위치는 `drawRoiOverlay` 체인의 `drawAutoRoi(ctx)` **바로 뒤**(가산 레이어 관례 그대로). 앞선 레이어가 이미 다 그려진 뒤이므로 이 함수가 즉시 return 하면 **캔버스 픽셀은 이전과 완전히 동일**하다.
- `ctx.save()`/`ctx.restore()` 로 감싸 `strokeStyle`·`lineWidth`·`setLineDash` 가 후속 레이어로 새지 않는다.

> 캔버스 밖 부수효과 1건(정직 기록): 체인에 `renderApTarget()` 을 추가했다. 이것은 **신규 엘리먼트 `#ap-target` 의 textContent 만** 갱신하며 기존 엘리먼트·캔버스를 건드리지 않는다. 위치는 기존 `updateGroundBadge()`·`updateAnchorBadge()`·`updateVehicleCuboidBadge()` 와 같은 배지 갱신 묶음이다(그 관례를 따랐다).

### (다) 유닛 봉인 — `test/autoPaint.test.ts`
- 토글 태그에 `checked` 없음
- `drawAutoPaint` **첫 줄이 정확히 그 조기 return 문장**
- `drawAutoPaint` 본문이 기존 레이어 함수 5개를 **호출하지 않음**
- 체인에서 `drawAutoRoi` **뒤**에 붙음
- 색이 시안(`#00e5ff`)이고 기존 3색(`#39ff14`·`#ff9f1c`·`#b47cff`)을 쓰지 않음
- 기존 `callRpc` 가 여전히 `api('/rpc')`(Unity 프록시)

---

## 5. 테스트 결과

| 항목 | 결과 |
|---|---|
| `npx tsc --noEmit` | **exit 0** |
| `npx vitest run` | **283 파일 / 3600 테스트 전량 green** (기준선 282/3564 + 신규 1파일/36테스트, 기존 실패 0) |
| 신규 `test/autoPaint.test.ts` | 36/36 green |

**라이브 확인**(서버 13020 **재시작 없음** — `web/` 은 정적자산이라 새로고침이면 반영):
- `/viewer/index.html` 에 신규 id **8개 전부 1건씩** 응답에 존재
- `/viewer/app.js` 에 `drawAutoPaint`·`settingRpc`·`apRun` **3개 존재**
- `/viewer/autoPaint.js` **HTTP 200** (신규 ESM 모듈이 정적 서빙됨 → 브라우저 import 해결됨)

**실 호출 검증**(읽기 전용 — 정본·DB 무접촉):

| 호출 | 소요 | 결과 |
|---|---|---|
| `roi.auto.detect {camId:1,presetIdx:1,consensus:false}` | **12.0초** | quad 7면, 전부 4점·정규화 0~1 범위 내, `frameHash 50783b11bfc4` |
| `roi.auto.score {camId:1,presetIdx:1,consensus:false}` | **11.6초** | `scored/graded` 해석 성공, 면별 라벨 7건, `frameHash 9357ad0b8b99` |

응답 원문을 **실제 `web/autoPaint.js` 모듈에 그대로 통과**시켜 정규화기가 실데이터에서 동작함을 확인했다.
- detect 요약: `프리셋 1:1 · 검출 7면 · frameHash 50783b11bfc4`
- score 요약: `평균 IoU 0.9766 · 최소 0.9728 · ≥0.95 7/7면 · ≥0.98 0면 · 프리셋 1:1 · 검출 7면 · frameHash 9357ad0b8b99`
- issues 실제 내용: `지면모델 주입: sim-place-meta(preset) …` / `지상고 자가보정: 5.000m → 5.051m (관측 칸간격 2.4746m vs 규격 2.5m, 계수 1.01025, 표본 21)` — 리더가 지목한 **진단 핵심이 실제로 화면에 뜬다.**
- 툴팁의 `off ≈ 12초` 는 실측 12.0/11.6초와 일치한다.

---

## 6. 리더 설계에서 벗어난 2건 (근거와 함께 보고)

### 6-1. 면별 IoU 라벨을 **자동 quad 가 아니라 수동 슬롯**에 붙였다

- 지시: "채점을 했으면 `IoU 0.97` 형식으로 면별 표시".
- **문제**: 응답에 **자동 quad ↔ 슬롯 귀속이 없다.** `scorePreset`(`src/ground/roiAutoScore.ts:191`)은 슬롯마다 자동 quad 전체에 대한 IoU **최댓값**만 남기고 어느 quad 였는지는 버린다. 순서로 짝짓는 것은 **지어내는 것**이라 하지 않았다.
- **처리**: 자동 quad 는 **실선 시안 + 격자 인덱스**(`#-7`), 수동 슬롯은 **점선 시안 + `s1 IoU 0.978`** 로 덧그린다. 좌표는 이미 뷰어가 가진 `state.placeRoi`(정본 파일) + 기존 헬퍼 `placeQuadOf` 를 쓴다. **뷰어는 IoU 를 재계산하지 않는다.**
- **결과**: 「자동(실선) vs 수동(점선) + 그 쌍의 IoU」가 한 화면에서 대조된다 — 목표("면별 점수를 눈으로 확인")를 오히려 더 직접 만족한다.

### 6-2. IoU 라벨 자릿수를 2 → **3** 으로 했다

- 지시 예시는 `IoU 0.97`(2자리)였다.
- **실측 근거**: 1:1 라이브 채점의 면별 IoU 가 `0.9784`·`0.9793` 인데 2자리로 자르면 전부 **`0.98`** 로 보인다. 그런데 같은 화면의 요약은 **`≥0.98 0면`** 이다 → **화면이 스스로와 모순**된다. 0.98 은 이 프로젝트의 판정 경계값이라 하필 그 자리에서 반올림하면 안 된다.
- 3자리(`IoU 0.978`)로 바꾸고, 이 회귀를 유닛테스트로 못 박았다(`판정 경계(0.98) 바로 아래 값이 0.98 로 보이지 않는다`).
- 요약 평균은 4자리(판정용), 면별 라벨은 3자리(가독성)로 자릿수를 나눴다.

---

## 7. `roi.auto.apply` 미배선 (지시 §4 준수)

UI·코드 어디에도 배선하지 않았다. 유닛테스트가 **정적으로 봉인**한다:
- `app.js` 에 `'roi.auto.apply'` / `"roi.auto.apply"` **문자열 0건**(RPC 메서드는 반드시 따옴표 문자열로 넘어간다)
- `index.html` 에 `ap-apply` 엘리먼트 **0건**
- `apRun` 이 부르는 메서드는 `roi.auto.detect`·`roi.auto.score` **둘뿐**

패널 제목도 **「도색선 자동검출 (읽기 전용)」** 으로 못 박았다.
(설명 주석에는 "왜 없는지"를 적기 위해 이름이 등장한다 — 봉인은 **호출**만 막는다.)

---

## 8. 마스터가 확인할 절차

1. 브라우저에서 **`http://127.0.0.1:13020/viewer/index.html`** 을 연다. **강력 새로고침(Ctrl+F5)** — `app.js`·신규 `autoPaint.js` 가 캐시돼 있을 수 있다.
2. 좌측 패널을 **「지면 격자 (자동 바닥 ROI)」 바로 아래**까지 내리면 **「도색선 자동검출 (읽기 전용)」** 패널이 있다.
   맨 왼쪽 `대상 1:1 (현재 화면)` 이 **지금 보고 있는 프리셋**을 가리키는지 확인한다(별도 입력 없이 이 값이 쓰인다).
3. **「검출」** 을 누른다.
   - 두 버튼이 **잠기고** `검출 중… 3초 경과 (예상 약 12초 · cam 1 preset 1)` 처럼 **1초마다 경과가 올라간다.**
   - 약 12초 뒤 상단 **「도색선」 토글이 자동으로 켜지고**, 영상 위에 **시안색 실선 주차면**이 뜬다(라벨 `#-7` 등 격자 인덱스).
   - `#ap-msg` 에 `프리셋 1:1 · 검출 7면 · frameHash …` 가 뜬다.
4. **「검출 + 채점」** 을 누른다(약 12초).
   - 시안 **실선**(자동) 위에 시안 **점선**(수동 정본)이 겹치고, 점선 위에 **`s1 IoU 0.978`** 형식의 면별 점수가 뜬다.
   - 요약이 `평균 IoU 0.9766 · 최소 0.9728 · ≥0.95 7/7면 · ≥0.98 0면 · … · frameHash …` 로 바뀐다.
5. 요약 아래 **「issues」 접이식**을 펼친다 → `지상고 자가보정: 5.000m → 5.051m (…계수 1.01025, 표본 21)` 같은 진단 로그가 보인다.
6. **회귀 확인**: 상단 **「도색선」 토글을 끈다** → 시안 레이어만 사라지고 **기존 화면(초록 바닥·주황 자동ROI·검출 박스·육면체)이 그대로**여야 한다.
7. (선택) **「다시점 합의」** 를 체크하고 다시 실행 → 카메라가 6번 흔들리며 **약 70초** 걸린다. 경과 표시가 계속 올라가는지 본다.

---

## 9. 미검증 · 정직 기록

| # | 항목 | 상태 |
|---|---|---|
| 1 | **브라우저 육안 렌더** — 시안 quad 가 실제로 영상 위 올바른 위치에 그려지는가 | **마스터 육안 확인 대기.** 나는 브라우저를 열 수 없다. 좌표 변환은 기존 `toPixelQuad` 를 그대로 쓰고 응답 좌표가 0~1 범위임을 실데이터로 확인했지만, **화면에서 본 것은 아니다** |
| 2 | 다시점 합의(`consensus:true`) 실호출 | **미측정.** 70초 × 카메라 6회 이동이라 실행하지 않았다. 파라미터 전달 경로는 유닛으로 봉인 |
| 3 | 여러 프리셋 동시 응답(camId/presetIdx 생략) | **미측정.** UI 는 항상 현재 1건만 보낸다. 정규화기는 다건도 처리하나 실데이터 확인은 1건뿐 |
| 4 | 실카메라(RTSP) | **검증 0건**(기존 R10 그대로). 시뮬레이터 수치로 실카를 대변하지 않는다 |
| 5 | `roi.auto.detect/score` 가 Unity 에 건 `roi.show2d{visible:false}` | 서비스 기존 동작이며 **되돌리지 않는다**(내 변경 아님). 시뮬레이터의 2D ROI 표시가 꺼져 있을 수 있다 |
| 6 | 정본에 없는 슬롯의 IoU 라벨 | 정본에 그 면이 없으면 붙일 자리가 없어 **조용히 skip** 한다(강등 철학). 실측 1:1 에서는 7/7 전부 자리가 있었다 |
