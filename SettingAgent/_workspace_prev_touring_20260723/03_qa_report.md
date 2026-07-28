# 검증 리포트: 카메라 타입 콤보박스

## 테스트 파일
`test/cameraKindSelect.test.ts` — 정적 소스 단언 규약(viewerDisplayReset 선례). DOM 실행 없이 app.js/index.html 텍스트로 결선을 가드.

## 신규 테스트(6/6 통과)
1. index.html: opt-camera-kind 가 select 이며 readonly input 아님.
2. index.html: 시뮬레이터(sim)·리얼카메라(hucoms) 두 옵션 존재.
3. renderCameraSource: kind 로 콤보 value 세팅(hucoms→hucoms, 그 외→sim), 과거 "Hucoms 실카메라" 표시문 제거 회귀 가드.
4. captureCameraSourceEdits: 콤보 선택을 source.kind 로 확정.
5. change 리스너: capture 후 renderCameraSource(renderedCameraSourceId) 재렌더.
6. cameraSettingsPatch: `kind: source.kind` 저장 patch 포함(백엔드 편집 경로 연결).

```
Test Files  1 passed (1)
     Tests  6 passed (6)
```

## 회귀 검증(인접 66/66 통과)
settingsFormErrors(12) · settingsStore(17) · settingsRoutes(7) · dbViewSourceSwitch(6) · viewerDisplayReset(8) · cameraMode(16).
```
Test Files  6 passed (6)
     Tests  66 passed (66)
```
- settingsRoutes GET/PUT 라운드트립 통과 → kind 편집이 백엔드 shape 과 정합.

## 후속: protocol 자동 정합 테스트(전체 11 테스트로 확장)
- `alignProtocolToKind` 순수 단위 5 케이스: hucoms→항상 hucoms-v1.22 / sim+unity계열 유지 / sim+비unity→unity-rpc / 멱등 / cameraSettingsPatch protocol 포함·capture 결선 단언.
- **전체 스위트 재실행: 212 파일 / 2524 테스트 통과**(core.js 변경 광범위 import 회귀 없음 확인).

## 한계(은닉 없이 명시)
- 실제 브라우저 DOM 렌더/클릭 상호작용은 정적 단언으로 대체(테스트 환경 node, jsdom 미구성 — 저장소 규약). 실 화면 육안 확인은 서버 구동 후 별도 필요.
- protocol-kind 정합은 검증 대상 아님(범위 밖, 미변경).
