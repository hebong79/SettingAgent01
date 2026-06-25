import cv2
import supervision as sv
from ultralytics import YOLO


def main():
    model_path = "./weights/yolo11x.onnx"
    image_path = "./images/car3d.png"

    model = YOLO(model_path)
    img = cv2.imread(image_path)
    results = model.predict(img, conf=0.25, iou=0.7)
    print(results)
    detections = sv.Detections.from_ultralytics(results[0])[0]
    print(detections)
    box_annotator = sv.BoxAnnotator()
    label_annotator = sv.LabelAnnotator()
    labels = [
        f"{class_name} {confidence:.2f}"
        for class_name, confidence in zip(detections["class_name"], detections.confidence)
    ]
    annotated_image = box_annotator.annotate(scene=img, detections=detections)
    annotated_image = label_annotator.annotate(scene=annotated_image, detections=detections, labels=labels)
    cv2.imwrite("annotated_image.jpg", annotated_image)


if __name__ == "__main__":
    main()
