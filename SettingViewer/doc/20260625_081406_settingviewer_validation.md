# SettingViewer 웹 설계서 검증 내용

- 작성일: 2026-06-25
- 대상 문서: `SettingViewer (웹) 설계서 — setup_artifact 시각화·시뮬레이터 제어`
- 목적: 설계서의 구조, API 계약, 스트리밍 방식, PTZ 제어, ROI 오버레이, 운영 리스크를 검토하고 구현 전 보완점을 정리한다.

---

## 1. 검증 결과 요약

결론부터 말하면, 전체 방향은 타당하다.

`SettingViewer(:13030)`가 **웹 뷰어 + 카메라 프록시**를 제공하고 ROI(/mapping)는 `SettingAgent(:13020)`를 프록시하는 구조는 CORS 문제를 피하고, 기존 `/mapping` 산출물을 재사용하기에 좋은 설계이다.

다만 구현 전에 반드시 정리해야 할 중요 보완점이 있다.

| 항목 | 판정 | 의견 |
|---|---:|---|
| 단일 출처 구조 | 통과 | `:13030`(SettingViewer)만 브라우저가 호출하고 ROI 는 :13020 /mapping 을 프록시하는 구조는 적절 |
| `/mapping` 기반 ROI 표시 | 통과 | `cam:preset` 키 결합 방식 적절(SettingViewer 가 SettingAgent :13020 /mapping 프록시) |
| 3fps 스냅샷 폴링 | 조건부 통과 | 가능하나 Blob URL 메모리 관리 필요 |
| PTZ 제어 | 조건부 통과 | 수동 모드와 `/req_img` 계약 충돌을 더 명확히 해야 함 |
| 정적 SPA 서빙 | 조건부 통과 | `/viewer/*`와 `/viewer/api/*` 라우팅 충돌 주의 |
| Fastify 프록시 | 통과 | 설계 방향 적절 |
| Unity 의존성 | 주의 | `/snapshot` 또는 `/stream` 없으면 수동 라이브는 제한됨 |
| 보안/운영 | 보완 필요 | LAN 노출 시 PTZ 제어 API 보호 필요 |

---

## 2. 가장 중요한 문제: 수동 PTZ 모드와 `/req_img` 충돌

설계서에서 이미 잘 짚은 핵심 문제이다.

현재 계약은 다음과 같다.

```text
POST /req_img
{ cam_idx, preset_idx, pan?, tilt?, zoom? }
```

그리고 설명에는 다음 내용이 있다.

```text
/req_img는 호출마다 preset_idx를 재적용한다.
```

이 경우 수동 PTZ에서 다음 문제가 생긴다.

1. 사용자가 `/req_move`로 카메라를 오른쪽으로 이동한다.
2. 다음 프레임을 얻기 위해 `/req_img { cam_idx, preset_idx }`를 호출한다.
3. Unity가 다시 해당 preset 위치로 이동한다.
4. 사용자가 수동으로 움직인 위치가 사라진다.

즉, **수동 제어 중 3fps 라이브 스트림은 현재 계약만으로는 제대로 구현하기 어렵다.**

설계서의 대응 방향은 적절하다.

```text
Unity에 GET /snapshot?cam_idx= 추가 권장
```

이 항목은 반드시 구현 결정 사항으로 올리는 것이 좋다.

### 권장 수정

성공 기준 G3, G4를 다음처럼 나누는 것을 권장한다.

```markdown
G3-1 프리셋 보기 모드에서는 /req_img 기반 3fps 폴링이 동작한다.
G3-2 수동 제어 모드에서는 Unity /snapshot 또는 /stream 지원 시 현재 PTZ 뷰를 3fps로 표시한다.
G3-3 Unity /snapshot 미지원 시 수동 제어는 "이동 후 1회 갱신" 모드로 제한된다.
```

이렇게 해야 구현자가 수동 라이브가 프리셋으로 되돌아가는 현상을 버그인지 계약 한계인지 명확히 구분할 수 있다.

---

## 3. `/req_img`의 `pan?`, `tilt?`, `zoom?` 의미 확인 필요

문서에는 `/req_img` 입력이 다음과 같이 되어 있다.

```ts
{
  cam_idx,
  preset_idx,
  pan?,
  tilt?,
  zoom?
}
```

그런데 동시에 `/req_img`가 `preset_idx`를 재적용한다고 설명한다.

여기서 애매한 점이 있다.

### 가능한 해석 A

`preset_idx` 위치로 이동한 뒤, `pan/tilt/zoom`으로 최종 위치를 덮어쓴다.

이 경우 수동 모드에서 다음 방식이 가능할 수도 있다.

```json
{
  "cam_idx": 1,
  "preset_idx": 2,
  "pan": 1234,
  "tilt": 500,
  "zoom": 4
}
```

### 가능한 해석 B

`preset_idx`가 항상 우선이고 `pan/tilt/zoom`은 일부 보조값이다.

이 경우 수동 모드에는 쓸 수 없다.

현재 설계서는 B에 가깝게 쓰여 있다. 따라서 실제 Unity 동작이 A인지 B인지 확인해야 한다.

### 권장 보완 문구

```markdown
확인 필요:
Unity /req_img에서 pan/tilt/zoom이 preset_idx보다 우선하는지 확인한다.
- 우선한다면 manual snapshot 폴백으로 /req_img {cam_idx,preset_idx,pan,tilt,zoom} 사용 가능
- 우선하지 않는다면 manual live는 /snapshot 또는 /stream 추가 전까지 불가능
```

---

## 4. `/viewer/api/snapshot` 쿼리 파라미터 이름 통일 필요

설계서 안에서 쿼리 이름이 조금 섞여 있다.

프런트 의사코드:

```js
/viewer/api/snapshot?cam=${cam}&preset=${preset}&mode=${mode}
```

서버 쪽 설명:

```text
zod 검증(camIdx/presetIdx 양의 정수)
```

Unity 쪽 계약:

```text
cam_idx, preset_idx
```

이름이 세 종류이다.

| 계층 | 이름 |
|---|---|
| 프런트 URL | `cam`, `preset` |
| 서버 내부 | `camIdx`, `presetIdx` |
| Unity API | `cam_idx`, `preset_idx` |

기술적으로는 문제 없지만 구현 실수 가능성이 크다.

### 권장

프런트 API는 다음 중 하나로 고정하는 것이 좋다.

#### 안 A: 짧은 이름

```http
GET /viewer/api/snapshot?cam=1&preset=2&mode=preset
```

서버에서 변환:

```text
cam -> cam_idx
preset -> preset_idx
```

#### 안 B: 계약에 맞춘 이름

```http
GET /viewer/api/snapshot?cam_idx=1&preset_idx=2&mode=preset
```

웹 API로는 안 A가 깔끔하다. 다만 문서 전체에서 `cam`, `preset`으로 통일하고, 서버 내부 변환 규칙을 명시하는 것이 좋다.

---

## 5. Blob URL 메모리 누수 가능성

프런트 의사코드에 다음 부분이 있다.

```js
img.src = URL.createObjectURL(await res.blob());
```

이 방식은 동작하지만, 3fps로 계속 실행하면 Blob URL이 계속 쌓일 수 있다.

### 보완 필요

이전 URL을 revoke해야 한다.

예:

```js
let lastObjectUrl = null;

async function setImageFromResponse(res) {
  const blob = await res.blob();
  const nextUrl = URL.createObjectURL(blob);

  img.onload = () => {
    if (lastObjectUrl) URL.revokeObjectURL(lastObjectUrl);
    lastObjectUrl = nextUrl;
    drawRoiOverlay();
  };

  img.src = nextUrl;
}
```

또는 `img.decode()`를 사용할 수도 있다.

```js
const oldUrl = lastObjectUrl;
lastObjectUrl = nextUrl;
img.src = nextUrl;
await img.decode();
if (oldUrl) URL.revokeObjectURL(oldUrl);
drawRoiOverlay();
```

이 항목은 장시간 실행 안정성을 위해 반드시 넣는 것이 좋다.

---

## 6. ROI 오버레이는 `imgW`, `imgH`만으로는 부족할 수 있음

설계서의 변환 함수 자체는 맞다.

```js
function toPixel(rect, imgW, imgH) {
  return {
    px: rect.x * imgW,
    py: rect.y * imgH,
    pw: rect.w * imgW,
    ph: rect.h * imgH
  };
}
```

다만 실제 화면에서 `<img>`에 다음 같은 CSS가 들어가면 문제가 생길 수 있다.

```css
object-fit: contain;
```

이 경우 이미지 영역 안에 여백, 즉 letterbox가 생긴다.

예를 들어:

- 컨테이너는 1000x600
- 실제 JPEG 비율은 16:9
- `object-fit: contain`

이면 위아래 또는 좌우에 빈 공간이 생길 수 있다. 그런데 canvas가 컨테이너 전체를 덮으면 ROI가 밀린다.

### 권장 방식

초기 구현에서는 `<img>` 자체 크기에 canvas를 정확히 맞추는 방식이 좋다.

```html
<div class="viewport">
  <img id="cameraImage">
  <canvas id="overlay"></canvas>
</div>
```

```css
.viewport {
  position: relative;
  display: inline-block;
}

.viewport img {
  display: block;
  max-width: 100%;
}

.viewport canvas {
  position: absolute;
  left: 0;
  top: 0;
  pointer-events: none;
}
```

이 방식이면 `img.clientWidth`, `img.clientHeight`를 기준으로 ROI를 그릴 수 있다.

---

## 7. `/viewer/*` 정적 라우트와 `/viewer/api/*` 충돌 주의

Fastify에서 정적 서빙을 `/viewer/`에 걸면 `/viewer/api/...` 요청이 정적 파일로 먼저 잡힐 수 있다.

라우트 등록 순서와 prefix 처리에 주의해야 한다.

### 권장 구조

```ts
// 1. API 라우트 먼저 등록
fastify.get('/viewer/api/cameras', ...)
fastify.get('/viewer/api/snapshot', ...)
fastify.post('/viewer/api/move', ...)
fastify.get('/viewer/api/health', ...)

// 2. 정적 서빙은 그 다음 등록
fastify.register(fastifyStatic, {
  root: viewerStaticDir,
  prefix: '/viewer/',
})
```

그리고 SPA fallback이 필요하면 `/viewer`와 `/viewer/`만 명확히 처리한다.

```ts
fastify.get('/viewer', async (req, reply) => {
  return reply.redirect('/viewer/');
});
```

SPA가 단일 페이지라면 다음 요청이 정상 처리되면 충분하다.

```text
GET /viewer/        -> index.html
GET /viewer/app.js  -> app.js
GET /viewer/app.css -> app.css
```

---

## 8. 보안/운영 리스크: LAN에 PTZ 제어 API가 열림

서버가 LAN에서 접근 가능하도록 `0.0.0.0`으로 바인딩되어 있다면, 설계대로 다음 API가 네트워크에 노출된다.

```http
POST /viewer/api/move
```

즉, 같은 네트워크에 있는 사람이 URL만 알면 카메라를 움직일 수 있다.

### 최소 보완 권장

개발용이라도 다음 설정을 추가하는 것을 권장한다.

```jsonc
"viewer": {
  "enabled": true,
  "allowMove": true
}
```

운영 또는 조회 전용 모드에서는 다음처럼 둔다.

```jsonc
"viewer": {
  "enabled": true,
  "allowMove": false
}
```

이 경우 조회는 가능하지만 PTZ 제어는 막을 수 있다.

더 강화하려면 token 방식도 가능하다.

```jsonc
"viewer": {
  "enabled": true,
  "controlToken": "some-secret-token"
}
```

요청 시:

```http
POST /viewer/api/move
X-Viewer-Token: some-secret-token
```

초기 개발용이면 token까지는 과할 수 있지만, 최소한 `allowMove` 옵션은 넣는 것이 좋다.

---

## 9. 테스트 계획 보완 제안

현재 테스트 전략은 충분히 좋다.

특히 다음 항목은 적절하다.

```text
fastify.inject()
fetch mock
ROI 좌표 변환 유닛테스트
타이머/AbortController 테스트
```

다만 프런트 쪽은 아래 테스트가 추가되면 더 안전하다.

### 추가 권장 테스트

#### 1. Blob URL revoke 테스트

```text
새 프레임을 표시하면 이전 object URL이 revoke된다.
```

#### 2. 백프레셔 테스트

```text
이전 snapshot 요청이 끝나기 전에는 다음 요청을 시작하지 않는다.
```

#### 3. stop 테스트

```text
stop() 호출 시 timer가 해제되고 inflight 요청이 abort된다.
```

#### 4. ROI label 매핑 테스트

```text
slotId -> globalIdx 매핑이 올바르다.
globalIndex에 없는 slot은 slotId로 fallback 표시한다.
```

#### 5. plateRoiByPreset이 없는 경우

```text
번호판 ROI가 없어도 차량 ROI는 정상 표시된다.
```

---

## 10. 설계서에 바로 반영하면 좋은 수정안

### A. 미해결 결정 사항에 추가

기존 4개에 하나 더 추가하는 것을 권장한다.

```markdown
5. /req_img의 pan/tilt/zoom 우선순위 확인:
   /req_img가 preset_idx 적용 후 pan/tilt/zoom을 덮어쓰는지,
   아니면 preset_idx가 항상 최종 위치인지 확인 필요.
   결과에 따라 manual snapshot 폴백 구현 가능 여부가 달라진다.
```

### B. 프런트 구현 주의사항 추가

```markdown
### Blob URL 관리
스냅샷은 URL.createObjectURL(blob)로 표시하되, 이전 object URL은 새 이미지 로드 완료 후 URL.revokeObjectURL()로 해제한다. 3fps 장시간 실행 시 메모리 누수를 방지하기 위함이다.
```

### C. ROI 오버레이 주의사항 추가

```markdown
### 이미지-캔버스 정렬
ROI 좌표는 실제 표시된 이미지 픽셀 기준으로 변환한다.
초기 구현에서는 object-fit으로 인한 letterbox 오차를 피하기 위해
canvas를 img 요소와 동일한 크기/위치로 배치하고 img.clientWidth/clientHeight를 기준으로 그린다.
```

### D. 보안 옵션 추가

```jsonc
"viewer": {
  "enabled": true,
  "allowMove": true,
  "defaultFps": 3,
  "staticDir": "web"
}
```

설명:

```markdown
viewer.allowMove=false이면 POST /viewer/api/move는 403을 반환한다.
LAN 환경에서 조회 전용 뷰어로 운영할 때 사용한다.
```

---

## 11. 최종 판정

이 설계는 **구현 착수 가능한 수준**이다.

다만 아래 4가지는 구현 전에 꼭 결정해야 한다.

1. **Unity가 `/snapshot` 또는 `/stream`을 추가할지**
2. **`/req_img`에서 `pan/tilt/zoom`이 preset보다 우선하는지**
3. **수동 PTZ 제어 API를 LAN에 그대로 열어둘지, `allowMove` 같은 보호 옵션을 둘지**
4. **Blob URL 해제와 이미지/canvas 정렬 방식을 프런트 설계에 명시할지**

추천안은 다음과 같다.

```text
프런트: 빌드리스 바닐라 ESM + Canvas
서빙: SettingViewer(:13030) /viewer 단일 출처 (ROI 는 SettingAgent :13020 /mapping 프록시)
스트림: 우선 /req_img 기반 preset 모드 3fps
수동 라이브: Unity /snapshot 추가 권장
보안: viewer.allowMove 옵션 추가
정적 서빙: @fastify/static 사용
```

즉, 설계 방향은 맞고, **수동 라이브 캡처 계약과 운영 보안만 보강하면 승인해도 되는 설계**로 판단된다.
