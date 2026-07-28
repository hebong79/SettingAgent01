# SettingAgent RPC화 — 설계 다이어그램

> 작성일: 2026-07-28 18:46 · 브랜치 `worktree-feat-rpc-control-plane`
> 본문 설계서: [20260728_183010_SettingAgent_서버_RPC화_설계서.md](20260728_183010_SettingAgent_서버_RPC화_설계서.md)
> 이 문서는 **구현 착수 전 확정용 그림**입니다. 코드 구조·호출 흐름·데이터 정본·안전 게이트를 그림으로 고정한 뒤 구현합니다.

---

## 1. 컨텍스트 — 누가 SettingAgent 를 제어하는가

```mermaid
flowchart LR
  subgraph CTRL["제어자 (Control Plane 소비자)"]
    EXT["외부 프로그램·에이전트<br/>(신규 — 이번 작업의 대상)"]
    WEB["웹 클라이언트<br/>web/app.js · roimaker.js"]
    MCP["MCP 두뇌<br/>src/mcp/server.ts"]
  end

  SA["<b>SettingAgent 13020</b><br/>Fastify"]

  subgraph DOWN["하류 능력"]
    UNITY["Unity 13110<br/>JSON-RPC 76 method"]
    CAMR["리얼 카메라<br/>Hucoms · RTSP"]
    VPD["VPD 9081<br/>det · seg"]
    LPD["LPD 9082"]
  end

  subgraph CANON["정본 저장소"]
    ROI["PtzCamRoi.json<br/>주차면 ROI 정본"]
    DB[("setting.sqlite<br/>slot_setup 외 6테이블")]
    FILES["camerapos.json · slot_ptz.json<br/>ground_grid.json · lens_calibration.json<br/>setup_artifact.json · save/"]
  end

  EXT -. "지금은 경로 없음(REST 를 직접 호출해야 함)" .-> SA
  WEB -->|"REST 76 라우트"| SA
  MCP -->|"stdio · 도구 5개"| SA

  SA --> UNITY
  SA --> CAMR
  SA --> VPD
  SA --> LPD
  SA --> ROI
  SA --> DB
  SA --> FILES

  style EXT stroke-dasharray: 5 5
```

**문제**: 외부 제어자가 셋팅을 하려면 REST 76 라우트의 경로·본문·상태코드를 전부 알아야 하고, **웹 클라이언트에만 있는 로직 12건**(주차면 단건 편집·자동보정 적용·전역번호 자동부여 등)은 아예 흉내낼 수 없습니다.

---

## 2. To-Be — 단일 제어 평면

```mermaid
flowchart TB
  EXT["외부 프로그램·에이전트"]
  WEB["웹 클라이언트"]
  MCP["MCP 두뇌"]

  subgraph SA["SettingAgent 13020"]
    direction TB
    RPC["<b>POST /rpc</b> · GET /rpc/catalog<br/>JSON-RPC 2.0 (신규)"]
    REST["기존 REST 76 라우트<br/>(무변경 · 가산)"]

    subgraph CORE["src/rpc — 신규"]
      DISP["dispatch<br/>봉투 검증·게이트·에러매핑"]
      REG["methods<br/>메서드 표 58"]
      BR["bridge<br/>app.inject 위임"]
      SVC["services<br/>승격 12건 전용"]
    end

    DOM["도메인·잡 계층<br/>CaptureJob · Finalizer · PtzCalibrator<br/>PlateDiscoveryJob · LensCalibrationJob · SetupPipeline"]
  end

  UNITY["Unity 13110"]
  STORE[("정본 파일 · SQLite")]

  EXT -->|"단일 진입점"| RPC
  MCP -->|"카탈로그 → 도구 자동 노출(Phase 4)"| RPC
  WEB -->|"현행 유지"| REST

  RPC --> DISP
  DISP --> REG
  REG --> BR
  REG --> SVC
  BR -->|"인메모리 위임"| REST
  REST --> DOM
  SVC --> DOM
  DISP -->|"unity.* 패스스루"| UNITY
  DOM --> STORE

  style RPC fill:#1f6feb,color:#fff
  style CORE stroke-dasharray: 4 3
```

**핵심**: RPC 는 **로직을 갖지 않습니다**. 기존 라우트로 위임(`bridge`)하거나, REST 에 존재하지 않는 승격분만 `services` 로 신설합니다 → 두 번째 구현이 생기지 않습니다(설계서 P1).

---

## 3. 모듈 구성 · 의존 방향

```mermaid
flowchart TB
  subgraph NEW["src/rpc (신규)"]
    R_ROUTES["routes.ts<br/>registerRpcRoutes"]
    R_DISP["dispatch.ts<br/>순수 디스패치"]
    R_METH["methods.ts<br/>메서드 표(카탈로그 메타 포함)"]
    R_BR["bridge.ts<br/>inject 어댑터"]
    R_ERR["errors.ts<br/>코드·HTTP 매핑"]
    R_TYPE["types.ts"]
    subgraph R_SVC["services/ — 승격 전용"]
      S1["placeSpaces.ts<br/>단건 편집·정렬·align 적용"]
      S2["cameraPresets.ts<br/>camerapos CRUD·gotoPreset"]
      S3["platePick.ts<br/>클릭 최근접 번호판"]
      S4["mappingAuto.ts<br/>전역번호 자동부여"]
    end
  end

  subgraph EXIST["기존 (무변경)"]
    E_SRV["api/server.ts"]
    E_ROUTES["api/*Routes.ts"]
    E_PLACE["capture/placeRoi.ts"]
    E_CTRL["calibrate/controlMath.ts<br/>pickNearestPlate"]
    E_CAMPOS["setup/cameraposWriter.ts<br/>mapTargets.parseCameraViews"]
    E_CRPC["clients/CRpcClient.ts"]
  end

  E_SRV -->|"한 줄 추가(가산)"| R_ROUTES
  R_ROUTES --> R_DISP
  R_DISP --> R_METH
  R_DISP --> R_ERR
  R_METH --> R_BR
  R_METH --> R_SVC
  R_BR -->|"app.inject"| E_ROUTES
  R_DISP -->|"unity.*"| E_CRPC
  S1 --> E_PLACE
  S2 --> E_CAMPOS
  S3 --> E_CTRL
  R_METH --> R_TYPE

  style NEW fill:#0d1117,stroke:#1f6feb
```

> 의존은 **신규 → 기존** 한 방향뿐입니다. 기존 모듈은 `src/rpc` 를 import 하지 않습니다(`api/server.ts` 의 등록 한 줄 제외).

---

## 4. 호출 흐름

### 4-1. 브리지 경로 (Phase 1·2 — 메서드 대부분)

```mermaid
sequenceDiagram
  autonumber
  participant EXT as 외부 제어자
  participant RPC as POST /rpc
  participant D as dispatch
  participant M as methods 표
  participant B as bridge
  participant RT as 기존 REST 라우트
  participant DOM as 도메인·정본

  EXT->>RPC: {jsonrpc, id, method:"slot.roi.sync", params:{}}
  RPC->>D: 봉투 파싱
  D->>M: method 조회
  alt 미등록
    M-->>EXT: error -32601 METHOD_NOT_FOUND
  end
  D->>D: mutating? → x-viewer-token 검사
  alt 토큰 불일치
    D-->>EXT: error -32006 FORBIDDEN
  end
  D->>B: http 매핑 {POST /capture/slots/sync-roi}
  B->>RT: app.inject (인메모리, 네트워크 0)
  RT->>DOM: syncRoiToDb — 차등 UPDATE·INSERT
  DOM-->>RT: {ok, updated, orphans[]}
  RT-->>B: 200 + payload
  B-->>D: result
  D-->>EXT: {jsonrpc, id, result:{ok, updated, orphans}}
```

### 4-2. 승격 서비스 경로 (Phase 3 — REST 에 없던 기능)

```mermaid
sequenceDiagram
  autonumber
  participant EXT as 외부 제어자
  participant D as dispatch
  participant SVC as services/placeSpaces
  participant P as capture/placeRoi.ts<br/>(기존 순수 함수)
  participant F as PtzCamRoi.json

  EXT->>D: method:"place.space.update"<br/>params:{camId,presetIdx,idx,points}
  D->>D: zod 검증(이 메서드의 유일한 정의처)
  D->>SVC: 호출
  SVC->>F: 읽기(원문 보관)
  SVC->>P: normalizePtzCamRoi → 프리셋 spaces
  SVC->>SVC: 단건 병합(read-modify-write)
  SVC->>F: .bak 생성 → applyPlaceRoiUpdateEx → 정본 쓰기
  SVC-->>EXT: {ok, idx, spaceCount, backupFile}
```

> **왜 승격이 필요한가**: 현행 `PUT /capture/place-roi` 는 프리셋을 **통째 교체**합니다. 외부 제어자가 전체 배열을 재구성하다 하나 빠뜨리면 주차면이 조용히 사라집니다(2026-07-28 8면→7면 실사고). 서버가 read-modify-write 를 소유해야 합니다.

### 4-3. 장기 잡 (센터라이징·수집·탐색·렌즈)

```mermaid
sequenceDiagram
  autonumber
  participant EXT as 외부 제어자
  participant D as dispatch
  participant BUSY as system.busy
  participant JOB as PtzCalibrator 등 잡

  EXT->>D: center.start {slotIds}
  D->>BUSY: 카메라 점유 확인
  alt 다른 잡 점유 중
    BUSY-->>EXT: error -32001 BUSY {who:"정밀수집"}
  end
  D->>JOB: start() — 즉시 반환(비동기)
  JOB-->>EXT: {ok, total:23}

  loop 폴링 (외부 제어자 주기 선택)
    EXT->>D: center.status
    D->>JOB: getStatus() — 기존 shape 그대로
    JOB-->>EXT: {state:"running", done:7, total:23}
  end

  EXT->>D: center.result
  D-->>EXT: slot_ptz.json 내용
```

### 4-4. Unity 패스스루

```mermaid
sequenceDiagram
  participant EXT as 외부 제어자
  participant D as dispatch
  participant C as CRpcClient
  participant U as Unity 13110

  EXT->>D: method:"unity.cam.setPTZ"
  D->>C: callRpc("cam.setPTZ", params)
  C->>U: POST /rpc (JSON-RPC 2.0)
  U-->>C: result
  C-->>EXT: result
  Note over D,U: Unity 미기동 → -32003 UPSTREAM<br/>(카탈로그 병합만 실패, 나머지 메서드는 정상)
```

---

## 5. 오류 매핑 — HTTP 상태 → RPC 코드

```mermaid
flowchart TB
  IN["기존 라우트 응답"] --> S{"status"}
  S -->|"2xx"| OK["result 로 그대로 전달"]
  S -->|"400"| E602["-32602 INVALID_PARAMS<br/>detail=zod flatten 보존"]
  S -->|"403"| E606["-32006 FORBIDDEN"]
  S -->|"404 (Fastify 미등록)"| E604A["-32004 UNAVAILABLE<br/>기능 미배선"]
  S -->|"404 (핸들러 본문)"| E602B["-32002 NOT_FOUND<br/>파일·결과 없음"]
  S -->|"409"| Q{"가드 종류"}
  Q -->|"잡 점유·already running"| E001["-32001 BUSY<br/>백오프 재시도 가능"]
  Q -->|"expectRawCount·slot_id 불일치"| E005["-32005 CONFLICT<br/>파일·DB 무변경 · 사람 개입"]
  S -->|"501 · 503"| E004["-32004 UNAVAILABLE"]
  S -->|"502"| E003["-32003 UPSTREAM<br/>카메라·VPD·LPD"]
  S -->|"500"| E603["-32603 INTERNAL"]

  style E001 fill:#9a6700,color:#fff
  style E005 fill:#a40e26,color:#fff
```

> **BUSY(-32001) 와 CONFLICT(-32005) 의 분리가 이 표의 핵심**입니다. 외부 제어자의 재시도 정책이 갈립니다 — BUSY 는 기다리면 풀리고, CONFLICT 는 기다려도 안 풀립니다.

---

## 6. 카메라 배타 · 잡 상태

```mermaid
stateDiagram-v2
  [*] --> idle
  idle --> running: capture.start / center.start /<br/>plate.discover.start / lens.start
  running --> stopping: *.stop
  running --> finalizing: 수집 완료
  stopping --> idle
  finalizing --> idle: 결과 기록
  running --> failed: 오류
  failed --> idle

  note right of running
    이 상태에서 다른 C 메서드는
    전부 -32001 BUSY {who}
    (system.busy 가 단일 판정처)
  end note
```

```mermaid
flowchart LR
  M["C 플래그 메서드<br/>cam.move · capture.* · center.* ·<br/>plate.detect · lens.start · place.align.*"] --> G{"system.busy"}
  G -->|"busy:false"| RUN["실행"]
  G -->|"busy:true"| REJ["-32001 + who"]
```

> 현재는 `lensCalib.isBusy` 클로저가 **렌즈 잡 시작에만** 이 판정을 합니다. RPC화에서 이를 **전역 `system.busy` 로 승격**해 모든 카메라 점유 메서드가 같은 판정을 공유합니다.

---

## 7. 정본 데이터 흐름 — 파괴 vs 비파괴

```mermaid
flowchart TB
  DRAW["place.space.add/update/delete<br/>place.save · grid.apply"] --> ROI["<b>PtzCamRoi.json</b><br/>주차면 ROI 정본"]
  ROI -->|"slot.roi.load ⚠ 전량 재구성"| DBX[("slot_setup")]
  ROI -->|"slot.roi.sync ✅ 차등"| DBX

  DET["plate.detect → plate.pickAt → plate.assign"] --> LPDC["slot_setup.lpd_obb"]
  LPDC --> OCC["slot.occupy.build<br/>→ occupy_range"]
  GM["slot.groundModel"] --> CUB["slot.cuboid.build<br/>→ slot3d_front_center"]
  CUB --> DISC["plate.discover.*"]
  DISC --> CEN["center.start<br/>→ centering_slot · slot_ptz.json"]
  DBX --> RESULT["setup.result.write<br/>→ save/setup_result_*.json"]
  LPDC --- DBX
  OCC --- DBX
  CUB --- DBX
  CEN --- DBX

  style ROI fill:#1f6feb,color:#fff
  style DBX fill:#1f6feb,color:#fff
```

**실측 근거(라이브 대조)** — 같은 편집에서:

| 경로 | 센터링·vpd·점유 | 판정 |
|---|---|---|
| `slot.roi.load` (`replaceSlotSetup` DELETE+INSERT) | 23 → **0** | ⚠ 파괴적 — `confirm:true` 필수 |
| `slot.roi.sync` (차등 UPDATE·INSERT) | 23 → **23** | ✅ 외부 제어자 기본 경로 |

```mermaid
flowchart LR
  START["빈 DB"] -->|"최초 1회만"| LOAD["slot.roi.load{confirm}<br/>FK 부모 부트스트랩"]
  LOAD --> SYNC["이후 항상 slot.roi.sync"]
  SYNC --> SYNC
  START -.->|"바로 sync → FOREIGN KEY 실패"| X(("✕"))
```

---

## 8. 파괴적 메서드의 안전 게이트

```mermaid
flowchart TB
  REQ["파괴적 메서드 요청"] --> G1{"confirm:true?"}
  G1 -->|"아니오"| R1["-32602 · 무변경"]
  G1 -->|"예"| G2{"기대값 가드<br/>expectRawCount ·<br/>slot_id 일치 · 매핑 검증"}
  G2 -->|"불일치"| R2["-32005 CONFLICT<br/><b>파일·DB 무변경</b>"]
  G2 -->|"일치"| G3["백업 생성<br/>_auto → .bak"]
  G3 --> W["정본 쓰기"]
  W -->|"실패"| RB["백업에서 자동 복원<br/>+ -32603"]
  W -->|"성공"| OK["{ok, applied, issues[]}<br/>+ backupFile"]
  OK --> UNDO["place.revert 로 되돌리기 가능"]

  style R2 fill:#a40e26,color:#fff
  style G3 fill:#0f5323,color:#fff
```

> 쓰기 순서 `_auto → .bak → 정본` 은 `groundGridRoutes.apply` 가 이미 쓰는 검증된 규약입니다. 승격 메서드도 **같은 규약**을 따릅니다(신규 규약 0).

---

## 9. 네임스페이스 → 정본 매핑

```mermaid
flowchart LR
  subgraph NS["RPC 네임스페이스 (58 메서드)"]
    N1["system.* (4)"]
    N2["cam.* (8)"]
    N3["place.* (11) + place.align.* (3)"]
    N4["grid.* (3)"]
    N5["slot.* (10)"]
    N6["plate.* (6)"]
    N7["center.* (4)"]
    N8["lens.* (5)"]
    N9["capture.* (7)"]
    N10["setup.* (7)"]
    N11["db.* (2) · config.* (1)"]
    N12["unity.*"]
  end

  N2 --> C1["camerapos.json"]
  N3 --> C2["PtzCamRoi.json"]
  N4 --> C3["ground_grid.json + PtzCamRoi.json"]
  N5 --> C4[("setting.sqlite")]
  N6 --> C4
  N7 --> C5["slot_ptz.json + centering_slot"]
  N8 --> C6["lens_calibration.json"]
  N9 --> C4
  N10 --> C7["setup_artifact.json · save/"]
  N11 --> C4
  N12 --> C8["Unity 13110"]
```

---

## 10. 헤드리스 완주 시나리오 (수용 테스트)

```mermaid
flowchart TB
  A["system.health"] --> B["place.create<br/>신규 주차장 골격"]
  B --> C["place.space.add ×N<br/>주차면 그리기"]
  C --> D["place.validateQuad<br/>사용가능 판정"]
  D --> E["grid.bootstrap<br/>자동생성 미리보기"]
  E --> F["grid.apply{confirm}<br/>주차열 일괄 생성"]
  F --> G["slot.roi.load{confirm}<br/>최초 1회 부트스트랩"]
  G --> H["slot.roi.sync<br/>이후 비파괴 동기"]
  H --> I["plate.detect<br/>라이브 LPD"]
  I --> J["plate.pickAt<br/>선택 차량 번호판"]
  J --> K["plate.assign<br/>슬롯 배정·DB 저장"]
  K --> L["slot.occupy.build<br/>점유영역"]
  L --> M["slot.cuboid.build<br/>앞면 중심"]
  M --> N["center.start → center.status<br/>센터라이징"]
  N --> O["setup.mapping.autoNumber<br/>→ slot.renumber"]
  O --> P["setup.result.write<br/>최종 셋업 파일"]

  style A fill:#0f5323,color:#fff
  style P fill:#0f5323,color:#fff
```

이 흐름 전체가 **브라우저 없이 RPC 호출만으로** 완주되면 목적 달성입니다.

---

## 11. 구현 단계 · 위험도

```mermaid
flowchart LR
  P0["<b>Phase 0</b><br/>RPC 코어<br/>dispatch·catalog·errors<br/>system.* · unity.*"] --> P1["<b>Phase 1</b><br/>읽기·저위험 브리지<br/>status·list·get·start"]
  P1 --> P2["<b>Phase 2</b><br/>정본 쓰기 브리지<br/>place·slot·grid·setup<br/>+ 가드 규약"]
  P2 --> P3["<b>Phase 3</b><br/>승격 서비스 12건<br/>place.space.* 외"]
  P3 --> P4["<b>Phase 4(선택)</b><br/>카탈로그 → MCP 도구<br/>SSE 이벤트"]

  P0 -.->|"위험 0<br/>기존 코드 무접촉"| N0[" "]
  P1 -.->|"위험 낮음<br/>읽기 위주"| N1[" "]
  P2 -.->|"위험 중<br/>가드 테스트 필수"| N2[" "]
  P3 -.->|"위험 중<br/>신규 로직"| N3[" "]

  style P0 fill:#0f5323,color:#fff
  style P1 fill:#0f5323,color:#fff
  style P2 fill:#9a6700,color:#fff
  style P3 fill:#9a6700,color:#fff
  style N0 fill:none,stroke:none
  style N1 fill:none,stroke:none
  style N2 fill:none,stroke:none
  style N3 fill:none,stroke:none
```

---

## 12. 제외 경계 — RPC 밖에 남는 것

```mermaid
flowchart TB
  subgraph IN["RPC 안 (58 메서드)"]
    I1["제어·판정·정본 쓰기"]
    I2["상태 조회·결과 조회"]
  end

  subgraph OUT["RPC 밖 (제외 14건)"]
    O1["MJPEG 스트림 · JPEG 프레임<br/>→ HTTP 유지 · RPC 는 URL 만"]
    O2["정적 SPA 서빙"]
    O3["카메라 로그인(자격증명)"]
    O4["임의 SQL<br/>→ db.table.query 화이트리스트만"]
    O5["PUT /settings (재시작 필요)"]
    O6["LLM 운영 · brain.* · warmup"]
    O7["vehicle-cuboids · job-cuboids<br/>(뷰어 렌더 전용 대용량)"]
    O8["레거시 /setup/run*"]
    O9["브라우저 렌더·히트테스트·<br/>임시 편집 버퍼"]
    O10["JSON-RPC 배치·notification"]
  end

  style OUT stroke-dasharray: 5 5
```

---

## 13. 착수 전 확정 사항

| 확정 | 내용 |
|---|---|
| 경로 | `POST /rpc` · `GET /rpc/catalog` (13020 루트). 기존 `/viewer/api/rpc`(Unity 프록시)는 **의미 불변** |
| 인증 | `viewer.controlToken` + `x-viewer-token` 재사용. 카탈로그의 `mutating` 이 게이트 대상의 단일 출처 |
| 위임 | Phase 1·2 는 `app.inject()` 브리지 — **기존 라우트 코드 이동 0** |
| 승격 | Phase 3 만 신규 서비스. REST 라우트는 추가하지 않음(RPC 전용 · 가산 최소) |
| 검증 | vitest — REST↔RPC 동등성 · 에러 매핑 · 가드 무변경 / 라이브 — 13020 기동 후 완주 시나리오 |
