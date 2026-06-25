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
        frame, bboxes, confidences, classes = self.plot_boxes(results, frame_bgr)

        return (frame, bboxes, confidences, classes)

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
        detections = sv.Detections.from_ultralytics(results)

        bounding_box_annotator = sv.BoxAnnotator(thickness=4)
        label_annotator = sv.LabelAnnotator(text_scale=2.0, text_thickness=4)

        labels = [
            f"{class_name} {confidence:.2f}"
            for class_name, confidence in zip(detections["class_name"], detections.confidence)
        ]

        bboxes = detections.xyxy.tolist()
        confidences = detections.confidence.tolist()
        classes = detections["class_name"]

        annotated_image = bounding_box_annotator.annotate(scene=frame, detections=detections)
        annotated_image = label_annotator.annotate(scene=annotated_image, detections=detections, labels=labels)

        return annotated_image, bboxes, confidences, classes
