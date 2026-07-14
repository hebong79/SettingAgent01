import platform

import cv2
import logfire
import numpy as np
import supervision as sv
import torch
from ultralytics import YOLO

from config import settings

logfire.configure(service_name="detector")


class YoloV8ImageObjectDetection:
    def __init__(self, chunked: bytes = None, model: YOLO = None):
        self._bytes = chunked
        self.model = model
        self.device = self._get_device()
        self.classes = self.model.names

    def _get_device(self):
        if platform.system().lower() == "darwin":
            return "mps"
        if torch.cuda.is_available():
            return "cuda:0"
        return "cpu"

    async def __call__(self):
        frame_bgr, frame_rgb = self._get_image_from_chunked()
        results = self.score_frame(frame_rgb)
        frame, polygons, confidences, classes = self.plot_boxes(results, frame_bgr)

        return (frame, polygons, confidences, classes)

    def _get_image_from_chunked(self):
        arr = np.asarray(bytearray(self._bytes), dtype=np.uint8)
        img_bgr = cv2.imdecode(arr, -1)  # 'Load it as it is'
        img_rgb = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2RGB)
        return img_bgr, img_rgb

    def score_frame(self, frame):
        frame = [frame]
        results = self.model(
            frame,
            conf=settings.YOLO_CONF_THRESHOLD,
            save_conf=True,
            device=self.device,
            verbose=False,
        )
        return results[0]

    def plot_boxes(self, results, frame):
        # OBB 4점 폴리곤 추출(ultralytics results.obb.xyxyxyxy → (N,4,2) 픽셀).
        # 검출 0건/비-OBB 모델 방어: 빈 결과 반환(annotate 생략, 원본 프레임 유지).
        obb = getattr(results, "obb", None)
        if obb is None or obb.xyxyxyxy is None or len(obb.xyxyxyxy) == 0:
            return frame, [], [], []

        polygons = obb.xyxyxyxy.cpu().numpy().tolist()  # (N,4,2) → 중첩 리스트
        confidences = obb.conf.cpu().numpy().tolist()
        classes = [self.classes[int(c)] for c in obb.cls.cpu().numpy()]

        # 주석 이미지(부차 — OBB 지원 supervision from_ultralytics 로 시각화).
        detections = sv.Detections.from_ultralytics(results)
        label_annotator = sv.LabelAnnotator(text_scale=1.4, text_thickness=4)
        labels = [f"{cls} {conf:.2f}" for cls, conf in zip(classes, confidences)]
        oriented_box_annotator = sv.OrientedBoxAnnotator(thickness=4)
        annotated_image = oriented_box_annotator.annotate(scene=frame, detections=detections)
        annotated_image = label_annotator.annotate(scene=annotated_image, detections=detections, labels=labels)

        return annotated_image, polygons, confidences, classes
