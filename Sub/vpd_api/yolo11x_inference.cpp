#include <opencv2/opencv.hpp>
#include <onnxruntime_cxx_api.h>
#include <iostream>
#include <vector>
#include <string>
#include <algorithm>
#include <cmath>
#include <chrono>

class YOLO11Detector {
private:
    Ort::Env env;
    Ort::Session session;
    Ort::MemoryInfo memory_info;
    std::vector<std::string> input_names;
    std::vector<std::string> output_names;
    std::vector<int64_t> input_shape;
    
    // COCO class names - index 2 is 'car'
    std::vector<std::string> class_names = {
        "person", "bicycle", "car", "motorcycle", "airplane", "bus", "train", "truck",
        "boat", "traffic light", "fire hydrant", "stop sign", "parking meter", "bench",
        "bird", "cat", "dog", "horse", "sheep", "cow", "elephant", "bear", "zebra",
        "giraffe", "backpack", "umbrella", "handbag", "tie", "suitcase", "frisbee",
        "skis", "snowboard", "sports ball", "kite", "baseball bat", "baseball glove",
        "skateboard", "surfboard", "tennis racket", "bottle", "wine glass", "cup",
        "fork", "knife", "spoon", "bowl", "banana", "apple", "sandwich", "orange",
        "broccoli", "carrot", "hot dog", "pizza", "donut", "cake", "chair", "couch",
        "potted plant", "bed", "dining table", "toilet", "tv", "laptop", "mouse",
        "remote", "keyboard", "cell phone", "microwave", "oven", "toaster", "sink",
        "refrigerator", "book", "clock", "vase", "scissors", "teddy bear", "hair drier",
        "toothbrush"
    };

public:
    struct Detection {
        cv::Rect2f bbox;
        float confidence;
        int class_id;
        std::string class_name;
    };

    YOLO11Detector(const std::string& model_path) 
        : env(ORT_LOGGING_LEVEL_WARNING, "YOLO11Detector"),
          memory_info(Ort::MemoryInfo::CreateCpu(OrtArenaAllocator, OrtMemTypeDefault)) {
        
        // Create session options
        Ort::SessionOptions session_options;
        session_options.SetIntraOpNumThreads(1);
        session_options.SetGraphOptimizationLevel(GraphOptimizationLevel::ORT_ENABLE_EXTENDED);
        
        // Create session
        session = Ort::Session(env, model_path.c_str(), session_options);
        
        // Get input/output names and shapes
        Ort::AllocatorWithDefaultOptions allocator;
        
        // Input info
        size_t num_input_nodes = session.GetInputCount();
        input_names.reserve(num_input_nodes);
        
        for (size_t i = 0; i < num_input_nodes; i++) {
            auto input_name = session.GetInputNameAllocated(i, allocator);
            input_names.push_back(input_name.get());
        }
        
        // Get input shape
        auto input_type_info = session.GetInputTypeInfo(0);
        auto input_tensor_info = input_type_info.GetTensorTypeAndShapeInfo();
        input_shape = input_tensor_info.GetShape();
        
        // Output info
        size_t num_output_nodes = session.GetOutputCount();
        output_names.reserve(num_output_nodes);
        
        for (size_t i = 0; i < num_output_nodes; i++) {
            auto output_name = session.GetOutputNameAllocated(i, allocator);
            output_names.push_back(output_name.get());
        }
        
        std::cout << "Model loaded successfully!" << std::endl;
        std::cout << "Input shape: [";
        for (size_t i = 0; i < input_shape.size(); i++) {
            std::cout << input_shape[i];
            if (i < input_shape.size() - 1) std::cout << ", ";
        }
        std::cout << "]" << std::endl;
    }

    cv::Mat preprocess(const cv::Mat& image) {
        cv::Mat resized, normalized;
        
        // Resize to model input size (typically 640x640 for YOLO11)
        int input_height = static_cast<int>(input_shape[2]);
        int input_width = static_cast<int>(input_shape[3]);
        
        cv::resize(image, resized, cv::Size(input_width, input_height));
        
        // Convert BGR to RGB and normalize to [0, 1]
        cv::cvtColor(resized, normalized, cv::COLOR_BGR2RGB);
        normalized.convertTo(normalized, CV_32F, 1.0 / 255.0);
        
        return normalized;
    }

    std::vector<Detection> detect(const cv::Mat& image, float conf_threshold = 0.25, float iou_threshold = 0.7) {
        cv::Mat preprocessed = preprocess(image);
        
        // Create input tensor
        std::vector<int64_t> input_tensor_shape = {1, 3, input_shape[2], input_shape[3]};
        size_t input_tensor_size = 1 * 3 * input_shape[2] * input_shape[3];
        
        std::vector<float> input_tensor_values(input_tensor_size);
        
        // Convert HWC to CHW format
        std::vector<cv::Mat> channels(3);
        cv::split(preprocessed, channels);
        
        int channel_size = static_cast<int>(input_shape[2] * input_shape[3]);
        for (int c = 0; c < 3; ++c) {
            std::memcpy(input_tensor_values.data() + c * channel_size, 
                       channels[c].data, channel_size * sizeof(float));
        }
        
        // Create input tensor
        auto input_tensor = Ort::Value::CreateTensor<float>(
            memory_info, input_tensor_values.data(), input_tensor_size,
            input_tensor_shape.data(), input_tensor_shape.size());
        
        // Run inference
        std::vector<const char*> input_names_cstr;
        std::vector<const char*> output_names_cstr;
        
        for (const auto& name : input_names) {
            input_names_cstr.push_back(name.c_str());
        }
        for (const auto& name : output_names) {
            output_names_cstr.push_back(name.c_str());
        }
        
        auto output_tensors = session.Run(Ort::RunOptions{nullptr}, 
                                        input_names_cstr.data(), &input_tensor, 1,
                                        output_names_cstr.data(), output_names.size());
        
        // Process outputs
        return postprocess(output_tensors[0], image.size(), conf_threshold, iou_threshold);
    }

private:
    std::vector<Detection> postprocess(Ort::Value& output_tensor, cv::Size original_size, 
                                     float conf_threshold, float iou_threshold) {
        // Get output tensor data
        float* output_data = output_tensor.GetTensorMutableData<float>();
        auto output_shape = output_tensor.GetTensorTypeAndShapeInfo().GetShape();
        
        std::vector<Detection> detections;
        
        // YOLO11 output format: [batch, num_detections, 84] where 84 = 4 (bbox) + 80 (classes)
        int num_detections = static_cast<int>(output_shape[1]);
        int num_classes = static_cast<int>(output_shape[2]) - 4;
        
        // Calculate scale factors
        float scale_x = static_cast<float>(original_size.width) / input_shape[3];
        float scale_y = static_cast<float>(original_size.height) / input_shape[2];
        
        for (int i = 0; i < num_detections; ++i) {
            float* detection = output_data + i * (num_classes + 4);
            
            // Extract bbox coordinates (center_x, center_y, width, height)
            float center_x = detection[0] * scale_x;
            float center_y = detection[1] * scale_y;
            float width = detection[2] * scale_x;
            float height = detection[3] * scale_y;
            
            // Find class with highest confidence
            float max_conf = 0.0f;
            int best_class = -1;
            
            for (int c = 0; c < num_classes; ++c) {
                float conf = detection[4 + c];
                if (conf > max_conf) {
                    max_conf = conf;
                    best_class = c;
                }
            }
            
            // Filter by confidence threshold and focus on cars (class_id = 2)
            if (max_conf >= conf_threshold && best_class == 2) {  // 2 is the class ID for 'car'
                Detection det;
                det.bbox.x = center_x - width / 2.0f;
                det.bbox.y = center_y - height / 2.0f;
                det.bbox.width = width;
                det.bbox.height = height;
                det.confidence = max_conf;
                det.class_id = best_class;
                det.class_name = class_names[best_class];
                
                detections.push_back(det);
            }
        }
        
        // Apply Non-Maximum Suppression
        return applyNMS(detections, iou_threshold);
    }
    
    std::vector<Detection> applyNMS(std::vector<Detection>& detections, float iou_threshold) {
        // Sort by confidence (descending)
        std::sort(detections.begin(), detections.end(), 
                 [](const Detection& a, const Detection& b) {
                     return a.confidence > b.confidence;
                 });
        
        std::vector<Detection> result;
        std::vector<bool> suppressed(detections.size(), false);
        
        for (size_t i = 0; i < detections.size(); ++i) {
            if (suppressed[i]) continue;
            
            result.push_back(detections[i]);
            
            // Suppress overlapping detections
            for (size_t j = i + 1; j < detections.size(); ++j) {
                if (suppressed[j]) continue;
                
                float iou = calculateIoU(detections[i].bbox, detections[j].bbox);
                if (iou > iou_threshold) {
                    suppressed[j] = true;
                }
            }
        }
        
        return result;
    }
    
    float calculateIoU(const cv::Rect2f& box1, const cv::Rect2f& box2) {
        float intersection_area = (box1 & box2).area();
        float union_area = box1.area() + box2.area() - intersection_area;
        return intersection_area / union_area;
    }
};

void drawDetections(cv::Mat& image, const std::vector<YOLO11Detector::Detection>& detections) {
    for (const auto& det : detections) {
        // Draw bounding box
        cv::rectangle(image, det.bbox, cv::Scalar(0, 255, 0), 2);
        
        // Draw label
        std::string label = det.class_name + ": " + std::to_string(det.confidence).substr(0, 4);
        int baseline;
        cv::Size text_size = cv::getTextSize(label, cv::FONT_HERSHEY_SIMPLEX, 0.5, 1, &baseline);
        
        cv::Point label_pos(static_cast<int>(det.bbox.x), 
                           static_cast<int>(det.bbox.y) - 10);
        
        cv::rectangle(image, 
                     cv::Point(label_pos.x, label_pos.y - text_size.height - baseline),
                     cv::Point(label_pos.x + text_size.width, label_pos.y + baseline),
                     cv::Scalar(0, 255, 0), cv::FILLED);
        
        cv::putText(image, label, label_pos, cv::FONT_HERSHEY_SIMPLEX, 0.5, 
                   cv::Scalar(0, 0, 0), 1);
    }
}

int main(int argc, char* argv[]) {
    try {
        // Default paths (can be overridden with command line arguments)
        std::string model_path = "./weights/yolo11x.onnx";
        std::string image_path = "./images/highway-traffic.jpeg";
        
        if (argc >= 2) model_path = argv[1];
        if (argc >= 3) image_path = argv[2];
        
        // Load the model
        std::cout << "Loading YOLO11x model from: " << model_path << std::endl;
        YOLO11Detector detector(model_path);
        
        // Load the image
        std::cout << "Loading image from: " << image_path << std::endl;
        cv::Mat image = cv::imread(image_path);
        if (image.empty()) {
            std::cerr << "Error: Could not load image from " << image_path << std::endl;
            return -1;
        }
        
        std::cout << "Image loaded. Size: " << image.cols << "x" << image.rows << std::endl;
        
        // Run detection
        std::cout << "Running car detection..." << std::endl;
        auto start_time = std::chrono::high_resolution_clock::now();
        
        std::vector<YOLO11Detector::Detection> detections = detector.detect(image, 0.25, 0.7);
        
        auto end_time = std::chrono::high_resolution_clock::now();
        auto duration = std::chrono::duration_cast<std::chrono::milliseconds>(end_time - start_time);
        
        std::cout << "Detection completed in " << duration.count() << " ms" << std::endl;
        std::cout << "Found " << detections.size() << " cars" << std::endl;
        
        // Print detection results
        for (size_t i = 0; i < detections.size(); ++i) {
            const auto& det = detections[i];
            std::cout << "Car " << i + 1 << ": "
                     << "bbox=[" << det.bbox.x << ", " << det.bbox.y << ", " 
                     << det.bbox.width << ", " << det.bbox.height << "], "
                     << "confidence=" << det.confidence << std::endl;
        }
        
        // Draw detections on image
        cv::Mat annotated_image = image.clone();
        drawDetections(annotated_image, detections);
        
        // Save the annotated image
        std::string output_path = "annotated_image_cars.jpg";
        cv::imwrite(output_path, annotated_image);
        std::cout << "Annotated image saved to: " << output_path << std::endl;
        
        // Optionally display the image (comment out if running headless)
        /*
        cv::imshow("Car Detection Results", annotated_image);
        cv::waitKey(0);
        cv::destroyAllWindows();
        */
        
    } catch (const std::exception& e) {
        std::cerr << "Error: " << e.what() << std::endl;
        return -1;
    }
    
    return 0;
} 