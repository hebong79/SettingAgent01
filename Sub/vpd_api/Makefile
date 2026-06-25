# Makefile for YOLO11x Car Detection in C++

CXX = g++
CXXFLAGS = -std=c++17 -O3 -Wall -Wextra
TARGET = yolo11_car_detection
SOURCE = yolo11x_inference.cpp

# OpenCV flags
OPENCV_FLAGS = $(shell pkg-config --cflags --libs opencv4)

# ONNX Runtime paths (adjust these based on your installation)
ONNXRUNTIME_ROOT = /usr/local
ONNXRUNTIME_INCLUDE = -I$(ONNXRUNTIME_ROOT)/include
ONNXRUNTIME_LIB = -L$(ONNXRUNTIME_ROOT)/lib -lonnxruntime

# All flags combined
INCLUDES = $(ONNXRUNTIME_INCLUDE)
LIBS = $(OPENCV_FLAGS) $(ONNXRUNTIME_LIB)

# Default target
all: $(TARGET)

# Build target
$(TARGET): $(SOURCE)
	$(CXX) $(CXXFLAGS) $(INCLUDES) -o $(TARGET) $(SOURCE) $(LIBS)

# Clean target
clean:
	rm -f $(TARGET)

# Install dependencies (Ubuntu/Debian)
install-deps:
	sudo apt update
	sudo apt install -y build-essential cmake pkg-config
	sudo apt install -y libopencv-dev python3-opencv
	@echo "Please install ONNX Runtime manually from:"
	@echo "https://github.com/microsoft/onnxruntime/releases"
	@echo "Download the Linux x64 version and extract to /usr/local/"

# Run the program
run: $(TARGET)
	./$(TARGET)

# Run with custom paths
run-custom: $(TARGET)
	./$(TARGET) ./weights/yolo11x.onnx ./images/highway-traffic.jpeg

# Help target
help:
	@echo "Available targets:"
	@echo "  all          - Build the executable"
	@echo "  clean        - Remove built files"
	@echo "  install-deps - Install system dependencies"
	@echo "  run          - Run with default paths"
	@echo "  run-custom   - Run with specified model and image paths"
	@echo "  help         - Show this help message"

.PHONY: all clean install-deps run run-custom help 