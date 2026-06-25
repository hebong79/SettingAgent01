# YOLO11x Car Detection in C++

A C++ implementation for detecting cars in images using YOLO11x ONNX model with OpenCV and ONNX Runtime.

## Features

- **High Performance**: Native C++ implementation for fast inference
- **Car-Specific Detection**: Filters results to show only cars (COCO class ID 2)
- **ONNX Runtime Integration**: Uses optimized ONNX Runtime for model inference
- **OpenCV Integration**: Efficient image processing and visualization
- **Non-Maximum Suppression**: Built-in NMS for removing duplicate detections
- **Configurable Thresholds**: Adjustable confidence and IoU thresholds
- **Visual Output**: Saves annotated images with bounding boxes and labels

## Prerequisites

### System Requirements
- Linux (Ubuntu 18.04+ recommended)
- C++17 compatible compiler (GCC 7+ or Clang 5+)
- CMake 3.16+ or Make

### Dependencies

1. **OpenCV 4.x**
   ```bash
   sudo apt update
   sudo apt install libopencv-dev python3-opencv
   ```

2. **ONNX Runtime**
   - Download from [ONNX Runtime Releases](https://github.com/microsoft/onnxruntime/releases)
   - Choose the Linux x64 version (e.g., `onnxruntime-linux-x64-1.16.3.tgz`)
   - Extract to `/usr/local/`:
   ```bash
   wget https://github.com/microsoft/onnxruntime/releases/download/v1.16.3/onnxruntime-linux-x64-1.16.3.tgz
   tar -xzf onnxruntime-linux-x64-1.16.3.tgz
   sudo cp -r onnxruntime-linux-x64-1.16.3/* /usr/local/
   sudo ldconfig
   ```

3. **Build Tools**
   ```bash
   sudo apt install build-essential cmake pkg-config
   ```

## Project Structure

```
├── yolo11x_inference.cpp   # Main C++ implementation
├── CMakeLists.txt         # CMake build configuration
├── Makefile              # Alternative Makefile build
├── README.md             # This file
├── weights/              # Place your ONNX model here
│   └── yolo11x.onnx
└── images/               # Place test images here
    └── highway-traffic.jpeg
```

## Building the Project

### Option 1: Using CMake (Recommended)

```bash
mkdir build
cd build
cmake ..
make -j$(nproc)
```

### Option 2: Using Makefile

```bash
make
```

## Usage

### Basic Usage

```bash
# Using default paths (./weights/yolo11x.onnx and ./images/highway-traffic.jpeg)
./yolo11_car_detection

# Or with Makefile
make run
```

### Custom Paths

```bash
# Specify custom model and image paths
./yolo11_car_detection path/to/model.onnx path/to/image.jpg

# Or with Makefile
make run-custom
```

### Example Output

```
Loading YOLO11x model from: ./weights/yolo11x.onnx
Model loaded successfully!
Input shape: [1, 3, 640, 640]
Loading image from: ./images/highway-traffic.jpeg
Image loaded. Size: 1280x720
Running car detection...
Detection completed in 45 ms
Found 8 cars
Car 1: bbox=[245.2, 145.8, 156.4, 98.2], confidence=0.872
Car 2: bbox=[567.1, 178.3, 142.7, 89.5], confidence=0.845
...
Annotated image saved to: annotated_image_cars.jpg
```

## Code Overview

### Key Components

1. **YOLO11Detector Class**: Main detection engine
   - Model loading and initialization
   - Image preprocessing (resize, normalize, format conversion)
   - ONNX Runtime inference
   - Postprocessing with NMS

2. **Detection Structure**: Holds detection results
   ```cpp
   struct Detection {
       cv::Rect2f bbox;        // Bounding box coordinates
       float confidence;       // Detection confidence score
       int class_id;          // COCO class ID (2 for cars)
       std::string class_name; // Class name ("car")
   };
   ```

3. **Key Methods**:
   - `detect()`: Main detection pipeline
   - `preprocess()`: Image preprocessing for model input
   - `postprocess()`: Parse model outputs and apply NMS
   - `applyNMS()`: Non-Maximum Suppression implementation

### Configuration

You can adjust detection parameters by modifying the default values in the `detect()` method call:

```cpp
// Current defaults: confidence=0.25, IoU=0.7
std::vector<Detection> detections = detector.detect(image, 0.25, 0.7);

// For more sensitive detection (lower confidence threshold)
std::vector<Detection> detections = detector.detect(image, 0.15, 0.7);

// For stricter NMS (lower IoU threshold)
std::vector<Detection> detections = detector.detect(image, 0.25, 0.5);
```

## Model Requirements

- **Format**: ONNX (.onnx)
- **Architecture**: YOLO11x
- **Input Shape**: [1, 3, 640, 640] (batch, channels, height, width)
- **Input Type**: Float32, normalized [0, 1], RGB format
- **Output**: [1, num_detections, 84] where 84 = 4 (bbox) + 80 (COCO classes)

### Getting YOLO11x ONNX Model

1. **From Ultralytics**:
   ```python
   from ultralytics import YOLO
   model = YOLO('yolo11x.pt')
   model.export(format='onnx')
   ```

2. **Download Pre-converted**: Check Ultralytics releases or model zoo

## Performance Tips

1. **CPU Optimization**:
   - The code uses single-threaded inference by default
   - Increase threads in session options for better CPU utilization:
   ```cpp
   session_options.SetIntraOpNumThreads(4);  // Use 4 threads
   ```

2. **GPU Acceleration** (if available):
   ```cpp
   // Add GPU provider (requires ONNX Runtime GPU build)
   session_options.AppendExecutionProvider_CUDA(OrtCUDAProviderOptions{});
   ```

3. **Memory Optimization**:
   - Batch multiple images for better throughput
   - Reuse detector instance for multiple images

## Troubleshooting

### Common Issues

1. **ONNX Runtime not found**:
   ```
   error while loading shared libraries: libonnxruntime.so
   ```
   Solution: Ensure ONNX Runtime is properly installed and run `sudo ldconfig`

2. **OpenCV not found**:
   ```
   fatal error: opencv2/opencv.hpp: No such file or directory
   ```
   Solution: Install OpenCV development packages

3. **Model loading fails**:
   - Verify model path is correct
   - Ensure model is YOLO11x ONNX format
   - Check model file permissions

4. **No detections found**:
   - Lower confidence threshold
   - Verify image loads correctly
   - Check if image contains cars

### Performance Issues

- **Slow inference**: Consider using GPU acceleration or optimized ONNX Runtime build
- **High memory usage**: Process images in smaller batches
- **Build errors**: Ensure all dependencies are properly installed

## License

This project is provided as-is for educational and research purposes. Please ensure compliance with YOLO11 and ONNX Runtime licenses for commercial use.

## Contributing

Feel free to submit issues and improvements. Key areas for contribution:
- GPU acceleration support
- Batch processing optimization
- Additional object classes support
- Performance benchmarking

