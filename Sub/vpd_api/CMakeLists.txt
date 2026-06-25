cmake_minimum_required(VERSION 3.16)
project(YOLO11CarDetection)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Find required packages
find_package(OpenCV REQUIRED)
find_package(PkgConfig REQUIRED)

# ONNX Runtime
set(ONNXRUNTIME_ROOT_PATH "/usr/local/onnxruntime-win-x64-gpu-1.22.1" CACHE PATH "ONNX Runtime root path")
set(ONNXRUNTIME_INCLUDE_DIRS "${ONNXRUNTIME_ROOT_PATH}/include")
set(ONNXRUNTIME_LIB_DIRS "${ONNXRUNTIME_ROOT_PATH}/lib")

# Include directories
include_directories(${OpenCV_INCLUDE_DIRS})
include_directories(${ONNXRUNTIME_INCLUDE_DIRS})

# Add executable
add_executable(yolo11_car_detection yolo11x_inference.cpp)

# Link libraries
target_link_libraries(yolo11_car_detection 
    ${OpenCV_LIBS}
    onnxruntime
)

# Add library directories
target_link_directories(yolo11_car_detection PRIVATE ${ONNXRUNTIME_LIB_DIRS})

# Compiler flags
target_compile_options(yolo11_car_detection PRIVATE -O3 -Wall -Wextra)

# Print information
message(STATUS "OpenCV version: ${OpenCV_VERSION}")
message(STATUS "OpenCV include dirs: ${OpenCV_INCLUDE_DIRS}")
message(STATUS "OpenCV libraries: ${OpenCV_LIBS}")
message(STATUS "ONNX Runtime include dirs: ${ONNXRUNTIME_INCLUDE_DIRS}")
message(STATUS "ONNX Runtime lib dirs: ${ONNXRUNTIME_LIB_DIRS}") 