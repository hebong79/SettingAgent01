# vLLM + Qwen2.5-VL-32B 설치 및 모델 선정 노트

작성일: 2026-07-03  
서버: Ubuntu, `aarch64`, NVIDIA 커널, Docker 기반 vLLM 실행 목표

## 1. 목표

Docker 기반으로 vLLM OpenAI 호환 API 서버를 띄우고, 기준 모델은 다음으로 한다.

```text
Qwen/Qwen2.5-VL-32B-Instruct
```

주요 사용 목적:

- 주차면 위 차량 존재 여부 판단
- 주차면 위 차량 점유 영역 또는 bbox/polygon 좌표 반환
- YOLO/번호판 detector 결과를 기반으로 PTZ 보정 판단
- Agentic AI 형태로 카메라 제어 전략 보정

## 2. 모델 비교 결론

### Qwen/Qwen2.5-VL-32B-Instruct

추천도: 높음

선정 이유:

- 이미지 입력 지원
- visual localization, bbox/point 생성, JSON 좌표 출력에 강점
- vLLM 사용 예시가 Hugging Face 모델 카드에 제공됨
- 주차면/차량 위치 판단처럼 좌표가 중요한 작업에 적합

권장 역할:

```text
차량/번호판 bbox 보정, 이미지 상황 판단, JSON 좌표 반환
```

### google/gemma-4-31B-it

추천도: 중간-높음

확인 사항:

- 이미지 입력을 지원하는 멀티모달 모델
- Text, Image 지원
- 추론, 코딩, 일반 멀티모달 이해에 강점

다만 주차면 차량 좌표 반환 목적에서는 Qwen2.5-VL-32B가 더 적합하다고 판단.

권장 역할:

```text
일반 이미지 이해, 추론, 코딩, 에이전트형 대화
```

### Qwen/Qwen3.6-35B-A3B

추천도: 높음, 단 VRAM 부담 큼

특징:

- 35B total, 약 3B activated MoE
- Vision Encoder 포함
- Agentic coding/agent 성능과 spatial benchmark가 강함
- PTZ 보정 정책 판단에는 좋은 후보

다만 Qwen2.5-VL-32B보다 최신이라 운영 안정성 검증은 별도 필요.

권장 역할:

```text
YOLO 결과, 현재 PTZ, 과거 히스토리를 받아 다음 PTZ 전략 결정
```

### gemma4:31b-coding-mtp-bf16

추천도: 이미지 분석 목적에는 낮음

이유:

- 이름상 coding/text 특화 모델일 가능성이 높음
- 비전 입력이 되는 체크포인트인지 확인되지 않음
- 단독으로 차량/번호판 좌표를 안정적으로 뽑기 어렵다

## 3. 시스템 설계 권장안

### 주차면 점유 판단

```text
입력 이미지
→ 주차면 polygon 사전 정의
→ YOLO 또는 Qwen2.5-VL로 차량 후보 탐지
→ SAM2 또는 YOLO-seg로 차량 mask/polygon 추출
→ parking_slot_polygon ∩ vehicle_polygon 계산
→ occupied / vehicle_polygon JSON 반환
```

### 번호판 중심 PTZ 제어

YOLO만으로 정확한 위치 특정이 어려운 경우에도, LLM/VLM이 매 프레임마다 저수준 PTZ 값을 직접 계산하게 하는 것은 비추천이다.

권장 구조:

```text
YOLO/번호판 detector = 실시간 좌표 측정
LLM/VLM Agent = 보정 판단, 실패 원인 해석, 다음 PTZ 전략 결정
PTZ controller = 실제 pan/tilt/zoom 명령
```

PTZ 계산 기본:

```text
plate_center_x = (x1 + x2) / 2
plate_center_y = (y1 + y2) / 2

pan_error  = plate_center_x - image_width / 2
tilt_error = plate_center_y - image_height / 2

current_plate_area_ratio = plate_bbox_area / image_area
zoom_error = 0.20 - current_plate_area_ratio
```

LLM/VLM Agent 입력 예:

```json
{
  "frame_size": [1920, 1080],
  "target": "license_plate",
  "desired_plate_area_ratio": 0.20,
  "current_ptz": {"pan": 0.32, "tilt": -0.08, "zoom": 0.41},
  "detections": [
    {
      "class": "license_plate",
      "bbox": [812, 464, 1030, 526],
      "confidence": 0.62,
      "track_id": 7
    }
  ],
  "history": [
    {
      "pan_delta": 0.02,
      "tilt_delta": -0.01,
      "zoom_delta": 0.04,
      "result": "plate moved closer to center"
    }
  ]
}
```

LLM/VLM Agent 출력 예:

```json
{
  "action": "pan_tilt_zoom_adjust",
  "pan_delta": 0.018,
  "tilt_delta": -0.006,
  "zoom_delta": 0.035,
  "confidence": 0.78,
  "reason": "plate is left-low of center and too small"
}
```

## 4. 현재 서버 확인 결과

실행 확인 시점:

```text
Fri Jul  3 16:40:05 KST 2026
Linux edgexpert-f6e7 6.17.0-1026-nvidia aarch64
```

확인된 상태:

```text
GPU: NVIDIA GB10
NVIDIA Driver: 580.159.03
CUDA Version: 13.0
Docker: 29.2.1
Python: 3.12.3
사용자: agent02
```

주의:

- `nvidia-smi`에서 GPU 메모리가 `Not Supported`로 표시됨
- 사용자가 `docker` 그룹에 없어 일반 `docker` 명령은 Docker socket permission denied 발생
- `sudo docker ...`는 sudo password 입력이 필요해 이 세션에서 직접 실행하지 못함

## 5. Docker/vLLM 실행 방식

vLLM은 호스트에 pip로 복잡하게 설치하기보다 Docker 이미지로 실행한다.

모델 캐시는 반드시 유지한다.

```bash
-v ~/.cache/huggingface:/root/.cache/huggingface
```

한 번 다운로드한 모델은 다음 실행 때 재사용된다.

## 6. Qwen2.5-VL-32B vLLM 실행 명령

기본 실행:

```bash
sudo docker run --rm --gpus all \
  --ipc=host \
  -p 8000:8000 \
  -v ~/.cache/huggingface:/root/.cache/huggingface \
  -e HF_TOKEN="$HF_TOKEN" \
  vllm/vllm-openai:latest \
  --model Qwen/Qwen2.5-VL-32B-Instruct \
  --dtype bfloat16 \
  --max-model-len 8192
```

GPU 메모리 여유가 부족하면:

```bash
--max-model-len 4096
```

멀티 GPU 또는 tensor parallel이 필요한 경우:

```bash
--tensor-parallel-size 2
```

## 7. 정상동작 체크

서버가 뜬 후 모델 목록 확인:

```bash
curl http://localhost:8000/v1/models
```

텍스트 요청:

```bash
curl -s http://localhost:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "Qwen/Qwen2.5-VL-32B-Instruct",
    "messages": [
      {"role": "user", "content": "짧게 자기소개해줘."}
    ],
    "max_tokens": 128
  }'
```

이미지 URL 요청:

```bash
curl -s http://localhost:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "Qwen/Qwen2.5-VL-32B-Instruct",
    "messages": [
      {
        "role": "user",
        "content": [
          {
            "type": "text",
            "text": "이미지에서 차량이 보이는지 판단하고, 보이면 대략적인 bbox를 JSON으로 반환해줘."
          },
          {
            "type": "image_url",
            "image_url": {
              "url": "https://upload.wikimedia.org/wikipedia/commons/thumb/3/3e/Toyota_Prius_III_20090720_front.JPG/640px-Toyota_Prius_III_20090720_front.JPG"
            }
          }
        ]
      }
    ],
    "max_tokens": 512,
    "temperature": 0
  }'
```

## 8. 권장 후속 작업

1. `agent02` 사용자를 docker 그룹에 추가

```bash
sudo usermod -aG docker agent02
```

로그아웃/로그인 후 확인:

```bash
docker ps
```

2. NVIDIA container runtime 확인

```bash
sudo docker run --rm --gpus all nvidia/cuda:13.0.2-base-ubuntu24.04 nvidia-smi
```

3. vLLM 이미지 ARM64 지원 확인

```bash
sudo docker run --rm --platform linux/arm64 vllm/vllm-openai:latest --help
```

4. Qwen2.5-VL-32B 다운로드 및 실행

```bash
sudo docker run --rm --gpus all \
  --ipc=host \
  -p 8000:8000 \
  -v ~/.cache/huggingface:/root/.cache/huggingface \
  -e HF_TOKEN="$HF_TOKEN" \
  vllm/vllm-openai:latest \
  --model Qwen/Qwen2.5-VL-32B-Instruct \
  --dtype bfloat16 \
  --max-model-len 8192
```

## 9. 최종 권장

현재 요구사항 기준 최종 추천:

```text
기준 모델: Qwen/Qwen2.5-VL-32B-Instruct
대안 모델: Qwen/Qwen3.6-35B-A3B
비교 모델: google/gemma-4-31B-it
정밀 polygon: YOLO-seg 또는 SAM2 병행
PTZ 보정: YOLO detector + VLM Agent + ONVIF/PTZ controller 루프
```

vLLM은 Docker로 운영하고, 모델 교체는 컨테이너 재실행 시 `--model` 값만 변경하는 방식이 가장 단순하다.



## 10. 실제 설치 및 동작 확인 결과

2026-07-03에 실제 서버에서 다음을 확인했다.

```text
Docker 권한: sg docker 방식으로 접근 확인
CUDA 테스트 컨테이너: nvidia/cuda:13.0.2-base-ubuntu24.04 + nvidia-smi 정상
vLLM 이미지: vllm/vllm-openai:latest ARM64 manifest 확인 및 다운로드 성공
vLLM 버전: 0.24.0
실행 모델: Qwen/Qwen2.5-VL-32B-Instruct
모델 아키텍처: Qwen2_5_VLForConditionalGeneration
체크포인트 크기: 63.59 GiB
모델 로딩 GPU 메모리: 62.44 GiB
실행 옵션: --dtype bfloat16 --max-model-len 4096 --gpu-memory-utilization 0.85
서버 주소: http://localhost:8000
컨테이너 이름: qwen25vl32b-vllm
```

기본 `--gpu-memory-utilization 0.92`에서는 다음 이유로 실패했다.

```text
Free memory on device cuda:0 (109.66/119.63 GiB) is less than desired GPU memory utilization (0.92, 110.06 GiB).
```

따라서 이 서버에서는 `--gpu-memory-utilization 0.85`를 기준값으로 둔다.

정상 확인:

```text
GET /v1/models: 200 OK
POST /v1/chat/completions 텍스트 요청: 200 OK
POST /v1/chat/completions base64 image_url 요청: 200 OK
```

외부 Wikimedia 이미지 URL 테스트는 컨테이너에서 403 Forbidden이 발생했다. 운영 테스트에서는 이미지 URL 서버의 접근 권한을 보장하거나, base64 data URL 또는 내부 스토리지 URL을 사용하는 것이 좋다.

현재 서버 종료 명령:

```bash
sg docker -c 'docker stop qwen25vl32b-vllm'
```

현재 로그 확인 명령:

```bash
sg docker -c 'docker logs -f qwen25vl32b-vllm'
```

## 11. 실행/중지/상태 확인 빠른 참조

이 서버에서는 `agent02` 계정의 docker 그룹 권한이 현재 셸에 바로 반영되지 않을 수 있으므로, 명령은 `sg docker -c '...'` 형태로 실행하는 것이 가장 확실하다.

### 현재 실행 상태 확인

컨테이너가 떠 있는지 확인한다.

```bash
sg docker -c 'docker ps --filter name=qwen25vl32b-vllm'
```

vLLM API가 실제 응답하는지 확인한다.

```bash
curl http://localhost:8000/v1/models
```

정상 응답에는 다음 모델 ID가 포함되어야 한다.

```text
Qwen/Qwen2.5-VL-32B-Instruct
```

### 실행

기존 컨테이너가 없거나 중지된 상태에서 실행한다.

```bash
cd /home/agent02/Work2/vLLM
sg docker -c './run_qwen25vl32b_vllm.sh'
```

주의: 이 스크립트는 foreground로 실행된다. 터미널을 닫으면 같이 종료될 수 있다. 장시간 운영하려면 아래의 백그라운드 실행 명령을 사용한다.

### 백그라운드 실행

```bash
sg docker -c 'docker rm -f qwen25vl32b-vllm >/dev/null 2>&1 || true; docker run -d --name qwen25vl32b-vllm --gpus all --ipc=host -p 8000:8000 -v /home/agent02/.cache/huggingface:/root/.cache/huggingface vllm/vllm-openai:latest --model Qwen/Qwen2.5-VL-32B-Instruct --dtype bfloat16 --max-model-len 4096 --gpu-memory-utilization 0.85'
```

처음 실행할 때는 모델 다운로드와 로딩에 오래 걸릴 수 있다. 이미 다운로드된 뒤에는 Hugging Face 캐시를 재사용한다.

### 중지

```bash
sg docker -c 'docker stop qwen25vl32b-vllm'
```

### 재시작

```bash
sg docker -c 'docker restart qwen25vl32b-vllm'
```

컨테이너가 삭제되었거나 옵션을 바꾸고 싶으면 중지 후 백그라운드 실행 명령을 다시 사용한다.

### 로그 확인

```bash
sg docker -c 'docker logs -f qwen25vl32b-vllm'
```

최근 로그만 확인하려면:

```bash
sg docker -c 'docker logs --tail 100 qwen25vl32b-vllm'
```

### 정상동작 테스트

문서와 함께 제공되는 체크 스크립트를 실행한다.

```bash
cd /home/agent02/Work2/vLLM
./check_vllm_qwen25vl32b.sh
```

이 스크립트는 다음을 확인한다.

```text
/v1/models
텍스트 chat completion
base64 이미지 입력 chat completion
```

### API 호출 예시

텍스트 요청:

```bash
curl -s http://localhost:8000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "Qwen/Qwen2.5-VL-32B-Instruct",
    "messages": [
      {"role": "user", "content": "짧게 자기소개해줘."}
    ],
    "max_tokens": 128,
    "temperature": 0
  }'
```

이미지 요청은 외부 URL이 403 또는 방화벽 문제를 만들 수 있으므로, 운영에서는 내부 이미지 URL 또는 base64 data URL을 권장한다.

### 모델 교체

다른 모델을 테스트하려면 컨테이너를 중지한 뒤 `--model` 값만 바꿔 다시 실행한다.

```bash
sg docker -c 'docker stop qwen25vl32b-vllm'
```

예를 들어 Gemma 4 31B로 바꿀 때:

```bash
sg docker -c 'docker run -d --name gemma4-31b-vllm --gpus all --ipc=host -p 8001:8000 -v /home/agent02/.cache/huggingface:/root/.cache/huggingface vllm/vllm-openai:latest --model google/gemma-4-31B-it --dtype bfloat16 --max-model-len 4096 --gpu-memory-utilization 0.85'
```

여러 모델을 동시에 띄울 때는 포트를 다르게 지정해야 한다. 예: `8000`, `8001`.

