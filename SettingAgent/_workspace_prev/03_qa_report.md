# SettingViewer 웹 뷰어 — 검증 보고서 (03_qa_report)

- 작성일: 2026-06-25
- 작성자: qa-tester (ParkAgent 검증자)
- 기준: `02_developer_changes.md` 인계 6개 테스트 포인트 + 설계서 §0.3 성공기준 G1~G4 / §10.2 테스트 전략
- 실행 명령: `npm --prefix SettingAgent test` (vitest run)

---

## 1. 실행 결과 (있는 그대로)

```
Test Files  25 passed (25)
     Tests  138 passed (138)
```

- **기존 81개 전부 통과(회귀 없음)** + **신규 57개 전부 통과**.
- 신규 테스트 파일 6개 / 57 케이스:

| 파일 | 케이스 | 대상 포인트 |
|------|-------:|------------|
| `test/cameraClientList.test.ts` | 6 | `CameraClient.listCameras()` A타입 파싱 |
| `test/simulatorSource.test.ts` | 6 | `SimulatorSource` 위임·항등 |
| `test/sourceRegistry.test.ts` | 4 | `buildSourceRegistry` 폴백·다중소스 |
| `test/realPtzSource.test.ts` | 8 | `RealPtzSource` Hucoms CGI(모킹) |
| `test/viewerRoutes.test.ts` | 14 | `/viewer/api/*` 라우트(fastify.inject) |
| `test/viewerCore.test.ts` | 19 | `web/core.js` 순수 로직 + `createStreamLoop` |

---

## 2. 작성 테스트 상세 + 성공기준 매핑

### 2.1 cameraClientList (포인트 1)
- 로컬 http 서버(`createServer`)로 `/cameras` 모킹(기존 presetProvider 테스트와 동일 패턴 — `globalThis.fetch` 스텁보다 견고).
- 검증: GET `/cameras` 호출 경로 확인 / **enabled=false 보존(A타입 그대로 — 제외하지 않음)** / label 폴백(`C{cam}-P{preset}`) / name 폴백(`C{cam}`) / presets PTZ 중첩 보존 / 404 시 throw.
- 경계면: `CameraClient.listCameras()` 반환 shape = `CameraSource.CameraList`(camIdx/name/enabled/presets[].presetIdx) 일치 확인.

### 2.2 simulatorSource (포인트 2)
- spy CameraClient 로 위임 인자 기록.
- 검증: **preset 모드 → requestImage 3번째 인자(ptz) undefined** / **manual 모드 → ptz override 동봉** / move 인자 순서(cam,pan,tilt,zoom) / list 위임 / **toNative·fromNative 항등(동일 참조 반환)**.

### 2.3 sourceRegistry (포인트 5)
- 검증: **cameraSources 미설정 → `id='sim'` 단일 SimulatorSource(하위호환)** / 빈 배열도 동일 폴백 / 다중(sim+hucoms) 등록·인스턴스 타입 / 삽입순서 첫 소스(라우트 기본 pickSource 근거).

### 2.4 realPtzSource (포인트 4) — Hucoms CGI 모킹
- 로컬 http 서버가 login/snapshot/ptz CGI 응답 + **모든 요청(method/url/body) 기록** → 자격증명 평문 누출 검사.
- 검증: login.cgi 성공(set-cookie 세션) / 실패(401→false) / snapshot image/jpeg(SOI 0xFFD8) / move 원시단위 매핑(`pan=36000/tilt=9000/zoom=36`) / **toNative↔fromNative 왕복 일치(4 샘플 toBeCloseTo)** / listCameras 라이브뷰 1개 / manual snapshot=move후캡처 / **전 요청 URL 에 자격증명 평문 미포함**(G — 보안).

### 2.5 viewerRoutes (포인트 3) — fastify.inject
- mock `CameraSource` + 임시 staticDir(최소 SPA 파일) 주입.
- 검증(G4·보안 포함):
  - cameras 200 JSON.
  - **snapshot preset**: `content-type=image/jpeg`, `Cache-Control: no-store`, `X-PTZ-Pan/Tilt/Zoom` 값, 바이너리 SOI, 소스에 `mode:'preset'`·ptz 미동봉.
  - **snapshot manual**: 소스에 `ptz` 동봉, X-PTZ-* 가 동봉값 반영(G3-2).
  - **snapshot zoom 클램프 99→36** / zod 실패(cam=0) → 400.
  - **move**: {ok:true}, 소스 인자, **zoom 클램프 99→36** (G4).
  - **move allowMove=false → 403** (소스 미호출 확인, G4).
  - **move controlToken 불일치 → 403 / 일치 → 200**.
  - **login(sim) → 400 'login unsupported', 응답 body 에 user/pass 미노출**.
  - **login(hucoms) → {ok:true}, 응답 body 자격증명 미노출, 소스에는 통과 전달**.
  - health {status:'ok', sources:[...]}.
  - **라우트 우선순위: `/viewer/api/cameras` 가 static 보다 먼저(JSON, HTML 아님)**.
  - 정적 서빙 `/viewer/index.html` 200 text/html / **`/viewer` → 302 `/viewer/`**.

### 2.6 viewerCore (포인트 6) — `web/core.js`
- `test/**/*.test.ts` 가 `../web/core.js` 직접 import(순수 ESM, 브라우저 API 불필요) — 정상 동작 확인.
- 검증:
  - **toPixel(0~1×표시크기) — G2** (전체/부분).
  - presetKey `cam:preset` / **slotLabel globalIdx 매칭·slotId 폴백·globalIndex 부재 폴백 — G3-4**.
  - fpsToInterval(3→333,1→1000) / clampZoom(0→1,99→36) / stepPtz(pan/tilt±step, zoom±1 클램프, 원본 불변).
  - **createStreamLoop**:
    - **백프레셔: inflight 중 겹침 tick 스킵(fetch 1회)** — G3-1.
    - **새 프레임 시 이전 Blob URL revoke, 첫 프레임은 revoke 없음** — G3-4.
    - onPtz 헤더 호출 / start 중복 무시 + `setTimer(…,333)` / **stop: timer clear + inflight abort(signal.aborted)** — G3-1.
    - **fake timers: 333ms 간격 3틱, stop 후 추가 호출 없음** — G3-1.

---

## 3. 발견 결함 — 없음 (구현자 재작업 불필요)

- 구현 버그로 인한 테스트 실패 없음. 신규 57 + 기존 81 = 138 전부 통과.
- 테스트 작성 중 자체 수정 1건(검증자 측, 구현 무관): `viewerCore` fake-timer 테스트에서 fetch 가 미해소면 inflight 가드로 1회만 호출되므로, 즉시 해소 fetch + `advanceTimersByTimeAsync` 로 보정(구현 정상, 테스트 설계 정정).

---

## 4. 경계면(shape) 교차 비교 결과 — 일치

소스 코드 정적 교차 검토(MCP/프록시 ↔ 소스 ↔ Unity REST ↔ 프런트):

| 경계 | 생산자 | 소비자 | 결과 |
|------|--------|--------|------|
| X-PTZ 헤더 | `routes.ts` `X-PTZ-Pan/Tilt/Zoom` | `web/app.js` `onPtz` `headers.get('X-PTZ-Pan/…')` | **일치**(대소문자 무관) |
| snapshot 쿼리 | `app.js` makeUrl `cam/preset/mode/t/source(+pan/tilt/zoom)` | `routes.ts` `SnapshotQuery` zod | **일치** |
| move body | `app.js` `{source,cam,pan,tilt,zoom}` | `routes.ts` `MoveBody` zod | **일치** |
| CameraList | `CameraClient.listCameras` `{camIdx,name,enabled,presets[]}` | `app.js` renderCamSelect/PresetSelect | **일치**, 1-based |
| ROI key | `core.presetKey(camIdx,presetIdx)` 1-based | `slot.roiByPreset[key]` | **일치** |
| plateRoi 부재 | `app.js` `slot.plateRoiByPreset?.[key]` 옵셔널 | — | **부재 시 차량 ROI만 정상**(설계 §10.2-5) |

추가 관찰(버그 아님): `app.js`는 `enabled=false` 카메라도 셀렉트에 `[off]` 표기로 렌더 → `listCameras`가 enabled=false 를 보존(A타입 passthrough)하는 것과 일관. presetProvider 의 flatten(enabled=false 제외)과 **용도가 다르므로 중복 아님**(설계 §9 명시와 일치).

---

## 5. 미커버 영역 (누락 명시 — 통과 위장 아님)

1. **실 PTZ 실기기 통합 스모크**: Hucoms HNR-2036LA(192.168.0.153) 미연결 → **수행 불가**. `RealPtzSource` 의 CGI 경로/원시 PTZ 범위/세션 추출 방식은 **가정값**(02_changes §5, 설계 §13.6). 단위테스트는 모킹 전제이며, 실측 보정 전까지 실기기 동작은 **미검증**.
2. **Unity 실서버(:13100) 스모크**: 미기동 → manual 모드에서 `/req_img` 가 override PTZ 를 응답에 실제로 반영하는지(해석 A) **미검증**. 단위는 spy echo 로만 확인. 설계 §10.1 12단계(동작확인 라운드) 보류.
3. **DOM 결선(`web/app.js`)**: jsdom 미도입(설계 §10 리스크 5) → DOM 이벤트·canvas 렌더·ResizeObserver 는 단위테스트 제외. 순수 로직(`core.js`)만 검증. G1(트리/목록 DOM 노드 수)·실제 캔버스 오버레이는 **브라우저 수동확인(스크린샷) 필요** — 본 라운드 미수행.
4. **@fastify/static 실제 디스크 서빙**: viewerRoutes 테스트는 임시 staticDir 에 최소 파일을 써서 검증했으나, 실제 `web/` 자산(index/app.css 등) 브라우저 로딩은 수동확인 영역.

---

## 6. 결론

- **통과/실패: 138 passed / 0 failed (신규 57 + 기존 81).**
- **발견 결함: 없음. 구현자 재작업 불필요.**
- 경계면 shape 불일치 없음(헤더·쿼리·바디·인덱스 1-based·ROI key 모두 일치).
- 보안 기준(자격증명 URL/로그/응답 평문 미노출) 단위 수준 충족.
- 잔여: 실 PTZ 실기기·Unity 실서버·브라우저 DOM 은 미커버(상기 §5). 설계 §10.1 12단계 동작확인 라운드에서 별도 수행 필요.
```
