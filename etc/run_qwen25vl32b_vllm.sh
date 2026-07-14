#!/usr/bin/env bash
set -euo pipefail

MODEL_ID="${MODEL_ID:-Qwen/Qwen2.5-VL-32B-Instruct}"
PORT="${PORT:-8000}"
MAX_MODEL_LEN="${MAX_MODEL_LEN:-8192}"
DTYPE="${DTYPE:-bfloat16}"
GPU_MEMORY_UTILIZATION="${GPU_MEMORY_UTILIZATION:-0.85}"
TENSOR_PARALLEL_SIZE="${TENSOR_PARALLEL_SIZE:-}"

args=(
  --rm
  --gpus all
  --ipc=host
  -p "${PORT}:8000"
  -v "${HOME}/.cache/huggingface:/root/.cache/huggingface"
)

if [[ -n "${HF_TOKEN:-}" ]]; then
  args+=(-e "HF_TOKEN=${HF_TOKEN}")
fi

serve_args=(
  --model "${MODEL_ID}"
  --dtype "${DTYPE}"
  --max-model-len "${MAX_MODEL_LEN}"
  --gpu-memory-utilization "${GPU_MEMORY_UTILIZATION}"
)

if [[ -n "${TENSOR_PARALLEL_SIZE}" ]]; then
  serve_args+=(--tensor-parallel-size "${TENSOR_PARALLEL_SIZE}")
fi

DOCKER_CMD="${DOCKER_CMD:-docker}"

exec ${DOCKER_CMD} run "${args[@]}" vllm/vllm-openai:latest "${serve_args[@]}"

