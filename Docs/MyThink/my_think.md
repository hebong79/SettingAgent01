*** 기본적인 내용 ***

> 상태 표기: [○] 완료 · [△] 부분 · [ ] 미완
> 최종 분석: 2026-07-09 (코드베이스 실측 기준). 근거는 `파일:라인` 병기.

** Setting Agent 의 할일 **
* [○] 시각화(뷰어) 프로그램 제작(카메라(시뮬레이터) 스트리밍)
    - MJPEG 연속 스트리밍(`/stream`, PTZ override 포함) + 폴링 폴백. `CameraClient.streamMjpeg`, `clients/mjpeg.ts`, `viewer/routes.ts`(GET /viewer/api/stream), `web/app.js:streamUrl`
    - RPC(13110) 전환됨(2026-07-12): 스트림은 현행 유지(CameraClient `/stream` 위임), 소스만 `RpcCameraSource`로 교체. `viewer/RpcCameraSource.ts`
    - 시뮬 연결 감지·카메라 정보 자동 갱신(2026-07-12): 4초 주기 폴로 `loadCameras` 재수신 → 카메라/프리셋 집합 변경 시에만 재렌더(선택 유지), `badge-camera`=Unity 연결. `web/app.js:connectionTick`, `core.js:pickSelected/camerasChanged`
    - 리얼/시뮬 카메라 선택(cameraMode, 디폴트 시뮬) 2026-07-13: `tools.config.json` `cameraMode:'simulator'|'real'`로 뷰어 라이브 소스 선택(config+재시작). 시뮬=CameraposSource(RPC 13110), 리얼=RealPtzSource(Hucoms, 실기 미확인 스텁). 정밀수집/검출은 여전히 RpcCameraClient(13110) → 실기 정밀수집 미지원(후속). `config/toolsConfig.ts`, `viewer/sourceRegistry.ts`, `docs/20260713_001412_카메라모드_리얼시뮬선택.md`
* [○] 시뮬레이터(카메라) 컨트롤 ( Pan, tilt, zoom )
    - `POST /viewer/api/move`→`/req_move`, zoom 1~36 클램프. `routes.ts:197`, `CameraClient.ts:121`
    - RPC(13110) 전환됨(2026-07-12): move → `cam.setPTZ`(죽은 13100 REST `/req_move` 대체). `viewer/RpcCameraSource.ts`
* [○] 시뮬레이터(카메라) 컨트롤 2 - 카메라별 프리셋 이동
    - `/cameras` 중첩 presets(pan/tilt/zoom) + 프리셋 스트림/스냅샷. `CameraClient.ts:102`
    - RPC(13110) 전환됨(2026-07-12): 목록은 `cam.list`+`preset.list`. 프리셋 의미가 **카메라 PTZ 프리셋 → 주차면 프리셋** 기반으로 바뀜(카메라 PTZ 없음, snapshot 시 `preset.select`로 활성 주차면 동기화). `viewer/RpcCameraSource.ts`
    - 카메라 PTZ 프리셋=camerapos.json 소유·웹 편집(2026-07-12): 뷰어 드롭다운 프리셋을 `CameraposSource`(파일 fresh read)로 환원, 주차면 프리셋(`preset.*`)과 분리. 웹에서 생성/수정/삭제 후 `PUT /viewer/api/camerapos` 저장. `viewer/CameraposSource.ts`, `docs/SETUP_GUIDE_초기셋팅.md`
* [○] vpd로 차량 위치 찾기 ( bbox ) - 뷰어에 출력
    - `VpdClient`, `POST /capture/detect`, 뷰어 오버레이(청록 rect). `app.js:drawDetectOverlay`
    - 정밀수집·검출·캘리브레이션 카메라 호출 RPC(13110) 전환됨(2026-07-12, RpcCameraClient): 죽은 13100 REST 대신 13110 /rpc(setPTZ/captureJPG)로 동작. `clients/RpcCameraClient.ts`
    - 정밀수집 탭 검출 박스 임시 편집(2026-07-13): 오버레이에서 VPD rect 8핸들·LPD quad 정점 선택·리사이즈·삭제(Delete/Esc). 메모리만(비영속, 프레임순환 시 소멸). `core.js:hitTestDetections/removeDetection`
* [○] lpd로 차량 번호판 찾기 ( OBB ) - 뷰어에 출력
    - `LpdClient`(4점 quad), 뷰어 폴리곤 렌더. `app.js:drawPlateQuad`
* [○] 주차면 확보 ( ROI ) - 파일에서 읽는다. ( 시뮬레이터에서 제공 )   ← 2026-07-09 완료
    - 파일 읽기·정규화·서빙 완료: `capture/placeRoi.ts`, `GET /capture/place-roi`
    - ROI 파일명 config화: `store.placeRoiFile`(dataDir 상대, 기본 `Place01/PtzCamRoi.json`) — `toolsConfig.ts`, `tools.config.json`, `index.ts`
    - [○] 카메라 틀어짐 자동보정(2026-07-13): 기준 프레임 저장(POST /capture/refframe)→상호상관 이동+스케일 추정(POST /capture/autocorrect, sharp 그레이 128×72)→ROI 이동/스케일 후 저장(PUT /capture/place-roi). 회전·원근 미보정. `capture/frameAlign.ts`, `placeRoi.ts:applyPlaceRoiUpdate`, `docs/20260713_011021_정밀수집_프리셋리스트_박스편집_자동보정.md`
    - [○] db에 저장한다. (cameraId, presetId, preset의 ptz, 이 프리셋의 주차면ROI들의 json  )
        · `parking_slots`에 cam_idx/preset_idx/roi_json/vpd_json/lpd_json **+ pan/tilt/zoom(preset PTZ)** 결합 저장(`SqliteStore.ts`, 마이그레이션 `addColumnsIfMissing`)
        · Finalizer가 `resolvePresetPtz`(GET /cameras)로 preset별 PTZ 조회 후 각 행에 주입(`Finalizer.ts`, camera 미주입 시 null 격리)
        · 검증: vitest +14(왕복·마이그레이션·config·Finalizer주입·라우트), 라이브(/capture/place-roi, /cameras preset PTZ) 확인
    - [○] 재사용 가능해야 한다.
        · DB 조회(`getParkingSlots`, pan/tilt/zoom 포함) + 결과 저장/열기(`SaveStore`, `/capture/save·/saves`) + 파일 재로드
* [△] UI 인덱스 매칭 리스트에 DB(ROI) 정보가 사용 돼야 한다.
    - 주차면 목록(slot-list)은 DB `parking_slots` 사용(`app.js:411`, `/capture/runs/:id/slots`)
    - **부분: "전역 인덱스 매칭 리스트"(수동 매핑)는 DB가 아닌 `setup_artifact.json` 사용**(`app.js:1407`). DB/파일 두 경로 혼재
* [○] 카메라 여러대, 프리셋 여러개에 대한 주차면 인덱스 매핑
    - [○] 카메라, 프리셋별 주차면이 통합인덱스(총주차면수)로 매칭 되어야 한다.
        · `GlobalIndexer.buildGlobalIndex`(cam→preset→pos 정렬 1-based) + `validateCoverage`. 다중 카메라 지원(현 설정 cam1만)
    - [○] UI에서 리스트 뷰, 선택, 추가, 수정, 삭제 기능
        · 목록/선택(`renderSlotList`), 중간삽입 추가(`addSlot`), 삭제(`deleteSelectedSlot`), ROI 편집·전역ID 매핑(`renderManualIndex`), 영속화(`PUT /mapping`)
* [△] 차량 번호판 센터라이징
    - 목적: 각 주차면의 P,t,z 정보를 얻기 위함이다.
    - 정밀수집·검출·캘리브레이션 카메라 호출 RPC(13110) 전환됨(2026-07-12, RpcCameraClient): `PtzCalibrator`의 requestImage/clampZoom이 13110 /rpc로 동작. 로직 무변경
    - LPD로 찾은 차량 번호판 OBB의 중심점으로 이동한 다음,
    - zoom을 이용해 차량번호판(OBB)의 가로 길이가 화면의 20%가 될때가지 확대한다.
    - 결정적(로직)으로 할수없으면 LLM을 이용하자.
    - 확대 완료후 ptz값을 리스트에 저장한다.
    - 모든 주차면이 완료되면 ptz값을 DB에 저장한다.(주차면id, 카메라id,프리셋id, p,t,z )
    - **구현 상태**: 로직 완결(OBB 중심 이동·zoom 20% 수렴·LLM 폴백·슬롯별 PTZ 축적). `PtzCalibrator.ts:140`, `controlMath.ts`, `config/tools.config.json:targetPlateWidth=0.2`
        · [△] **DB에 저장하되 필드가 JSON 형태임** — `data/slot_ptz.json`(`slotPtzWriter.ts:41`, "Repository 미사용" 명시). DB 테이블 저장 미구현
        · 참고(실측): 현재 `slot_ptz.json` 17개 항목 전부 `converged:false`(plate_lost/occluded) — 로직은 있으나 수렴 성공 데이터 없음(시뮬 튜닝 필요)
* [○] 셋팅 작업 파일 저장
    - `Repository.saveArtifact`→`data/setup_artifact.json` + DB `artifact_snapshot` 스냅샷. `Repository.ts:17`, `Finalizer.ts:204`
* [△] 센터라이징까지 해서 P4존(차량번호판이 잘 인식되게 확대된 위치) ptz 도 setup 파일에 저장
    - P4 PTZ는 `slot_ptz.json`(별도 파일)에만 저장됨
    - **미충족: 정본 `setup_artifact.json` 스키마에 슬롯별 PTZ 필드 없음**(`domain/types.ts:22`, `artifactSchema.ts`). slot_ptz.json ↔ setup_artifact.json 병합 코드 없음
* [ ] SettingAgent 프로젝트 전체를 에이전트화 한다.
    - 외부에서 자연어 명령으로 최종 셋업파일 저장까지 한다.
    - **미구현**: MCP 도구 3개만 노출(`camera_req_img`, `camera_req_move`, `vpd_detect` — `mcp/server.ts`). LPD·setup·calibrate·mapping 도구 없음
    - `AgentRuntime`은 판정/자문 전용 LLM 계층(비전 게이트)일 뿐 tool-calling 루프·좌표/명령 생성 없음
    - 오케스트레이션은 결정형 코드+명시적 REST/UI 버튼 구동. **자연어→전 과정→셋업파일까지의 자율 진입점 부재**
    - **[부분 진전 2026-07-12]** RPC control-plane(`/viewer/api/rpc*`, Unity 76 method 프록시)·멀티 LLM 선택 구조(`models[]`+런타임 전환)가 갖춰짐 → 기반 일부 제공. 남은 것은 자연어→tool-calling→RPC 오케스트레이션 진입점(자연어 오케스트레이션 자체는 여전히 미완)

---

## 작업 현황 요약 (2026-07-09 실측)

### ✅ 완료된 일
| 항목 | 근거 |
|------|------|
| 뷰어 카메라 스트리밍(MJPEG+PTZ) | `CameraClient.ts:76`, `routes.ts:128`, `web/app.js:782` |
| PTZ 컨트롤(pan/tilt/zoom) | `routes.ts:197`, `CameraClient.ts:121` |
| 카메라별 프리셋 이동 | `CameraClient.ts:102`, `SimulatorSource.ts:17` |
| VPD 차량 bbox → 뷰어 | `VpdClient.ts:43`, `captureRoutes.ts:326`, `app.js:377` |
| LPD 번호판 OBB → 뷰어 | `LpdClient.ts:56`, `app.js:363` |
| 주차면 ROI 파일 읽기 | `placeRoi.ts:32`, `PtzCamRoi.json` |
| 주차면 ROI 재사용(DB 조회/저장·열기) | `SqliteStore.ts:477`, `SaveStore` |
| 통합 인덱스 매칭(전 카메라·프리셋) | `GlobalIndexer.ts:16` |
| 매핑 UI(리스트/선택/추가/수정/삭제) | `app.js:411,577,595`, `PUT /mapping` |
| 센터라이징 로직(OBB중심·zoom20%·LLM폴백) | `PtzCalibrator.ts:140`, `controlMath.ts` |
| 셋업 아티팩트 파일 저장 | `Repository.ts:17`, `data/setup_artifact.json` |

### 🟡 부분 완료 (마무리 필요)
| 항목 | 되어있는 것 | 남은 것 |
|------|------------|---------|
| ~~주차면 ROI를 DB에 저장~~ **[완료 2026-07-09]** | parking_slots에 ROI·cam·preset **+ preset PTZ(pan/tilt/zoom)** 결합 저장, ROI 파일명 config화 | — |
| UI 인덱스 리스트에 DB ROI 사용 | slot-list는 DB 사용 | **전역 인덱스 매핑 리스트를 DB 소스로 통일**(현재 setup_artifact.json 사용) |
| 센터라이징 결과 저장 | 로직·slot_ptz.json 저장 | **DB 테이블 저장**(주차면id/카메라id/프리셋id/p,t,z) + 실제 수렴 성공까지 튜닝 |
| P4존 PTZ를 setup 파일에 저장 | slot_ptz.json에 저장 | **setup_artifact.json 스키마에 슬롯별 PTZ 필드 추가 + 병합** |

### 🔴 남아있는 일 (미착수)
| 항목 | 내용 |
|------|------|
| 전체 에이전트화 | 외부 **자연어 명령 → 셋업 전 과정 오케스트레이션 → 최종 셋업파일 저장**. MCP 도구 확장(LPD/setup/calibrate/mapping), tool-calling 루프, NL 진입점 필요 |

### 다음 우선순위 제안
1. **DB 스키마 통합** — `parking_slots`(또는 신규 preset 테이블)에 preset PTZ, 센터라이징 slot PTZ를 결합 저장 → 6a·9·11 동시 해결의 토대.
2. **setup_artifact 스키마 확장** — 슬롯별 PTZ(P4) 필드 추가 + slot_ptz.json 병합(11).
3. **UI 인덱스 리스트 소스 통일** — 전역 인덱스 매핑도 DB ROI 기반으로(7).
4. **센터라이징 수렴 튜닝** — 현재 전 항목 `converged:false`, 실제 성공 데이터 확보.
5. **에이전트화** — 능력의 MCP 노출 확장 + 자연어 오케스트레이션 진입점(12).




*** 다시 정리 ***

---------------------------------------------
* [○] 시각화(뷰어) 프로그램 제작(카메라(시뮬레이터) 스트리밍)   ← RPC(13110) 전환됨(2026-07-12): 스트림 현행 유지(소스만 RpcCameraSource)
* [○] 시뮬레이터(카메라) 컨트롤 ( Pan, tilt, zoom )   ← RPC(13110) 전환됨(2026-07-12): move → cam.setPTZ
* [○] 시뮬레이터(카메라) 컨트롤 2 - 카메라별 프리셋 이동   ← RPC(13110) 전환됨(2026-07-12): cam.list+preset.list, 프리셋 의미가 주차면 프리셋 기반으로 바뀜
* [○] vpd로 차량 위치 찾기 ( bbox ) - 뷰어에 출력  
    -[] 세그먼트 찾기 추가, 검지내용기반 3D육면체화 하기  
    -[] 주차면위의 차량만 검지하기 추가
* [○] lpd로 차량 번호판 찾기 ( OBB ) - 뷰어에 출력
    -  
* [○] 주차면 확보 ( ROI ) - 파일에서 읽는다. ( 시뮬레이터에서 제공 )   ← 2026-07-09 완료(preset PTZ 결합 저장 + ROI 파일명 config화)
* [△] UI 인덱스 매칭 리스트에 DB(ROI) 정보가 사용 돼야 한다.
    - 주차면 목록(slot-list)은 DB `parking_slots` 사용(`app.js:411`, `/capture/runs/:id/slots`)
    - **부분: "전역 인덱스 매칭 리스트"(수동 매핑)는 DB가 아닌 `setup_artifact.json` 사용**(`app.js:1407`). DB/파일 두 경로 혼재
    --> 일단 DB에만 사용한다.
* [△] 카메라 여러대, 프리셋 여러개에 대한 주차면 인덱스 매핑
    - [○] 카메라, 프리셋별 주차면이 통합인덱스(총주차면수)로 매칭 되어야 한다.
        · `GlobalIndexer.buildGlobalIndex`(cam→preset→pos 정렬 1-based) + `validateCoverage`. 다중 카메라 지원(현 설정 cam1만)
    - [○] UI에서 리스트 뷰, 선택, 추가, 수정, 삭제 기능
        · 목록/선택(`renderSlotList`), 중간삽입 추가(`addSlot`), 삭제(`deleteSelectedSlot`), ROI 편집·전역ID 매핑(`renderManualIndex`), 영속화(`PUT /mapping`)
        --> 현재 기능이 동작안함.( 반드시 DB 정보를 사용할것)
* [△] 차량 번호판 센터라이징 ( 새롭게 구현 예정 )   ← 정밀수집·검출·캘리브레이션 카메라 호출 RPC(13110) 전환됨(2026-07-12, RpcCameraClient)
    - 목적: 각 주차면의 P,t,z 정보를 얻기 위함이다.
    - LPD로 찾은 차량 번호판 OBB의 중심점으로 이동한 다음,
    - zoom을 이용해 차량번호판(OBB)의 가로 길이가 화면의 20%가 될때가지 확대한다.
    - 결정적(로직)으로 만들어 사용 ( 클로드 loop 이용 )
    - 확대 완료후 ptz값을 리스트에 저장한다.
    - 모든 주차면이 완료되면 ptz값을 DB에 저장한다.( 주차면id, 카메라id,프리셋id, p,t,z )
    - **구현 상태**: 로직 완결(OBB 중심 이동·zoom 20% 수렴·LLM 폴백·슬롯별 PTZ 축적). `PtzCalibrator.ts:140`, `controlMath.ts`, `config/tools.config.json:targetPlateWidth=0.2`
        · [△] **DB에 저장하되 필드가 JSON 형태임** — `data/slot_ptz.json`(`slotPtzWriter.ts:41`, "Repository 미사용" 명시). DB 테이블 저장 미구현
        · 참고(실측): 현재 `slot_ptz.json` 17개 항목 전부 `converged:false`(plate_lost/occluded) — 로직은 있으나 수렴 성공 데이터 없음(시뮬 튜닝 필요)
* [○] 셋팅 작업 파일 저장 --> 저장구조 다시 설정하자.
    - `Repository.saveArtifact`→`data/setup_artifact.json` + DB `artifact_snapshot` 스냅샷. `Repository.ts:17`, `Finalizer.ts:204`
* [△] 센터라이징까지 해서 P4존(차량번호판이 잘 인식되게 확대된 위치) ptz 도 setup 파일에 저장
    - P4 PTZ는 `slot_ptz.json`(별도 파일)에만 저장됨
    - **미충족: 정본 `setup_artifact.json` 스키마에 슬롯별 PTZ 필드 없음**(`domain/types.ts:22`, `artifactSchema.ts`). slot_ptz.json ↔ setup_artifact.json 병합 코드 없음
* [ ] SettingAgent 프로젝트 전체를 에이전트화 한다.
    - 외부에서 자연어 명령으로 최종 셋업파일 저장까지 한다.
    - **미구현**: MCP 도구 3개만 노출(`camera_req_img`, `camera_req_move`, `vpd_detect` — `mcp/server.ts`). LPD·setup·calibrate·mapping 도구 없음
    - `AgentRuntime`은 판정/자문 전용 LLM 계층(비전 게이트)일 뿐 tool-calling 루프·좌표/명령 생성 없음
    - 오케스트레이션은 결정형 코드+명시적 REST/UI 버튼 구동. **자연어→전 과정→셋업파일까지의 자율 진입점 부재**
    - **[부분 진전 2026-07-12]** RPC control-plane(`/viewer/api/rpc*`, Unity 76 method 프록시)·멀티 LLM 선택 구조(`models[]`+런타임 전환)가 갖춰짐 → 기반 일부 제공. 남은 것은 자연어→tool-calling→RPC 오케스트레이션 진입점(자연어 오케스트레이션 자체는 여전히 미완)