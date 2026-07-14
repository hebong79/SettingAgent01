from pathlib import Path

import cv2
import logfire
from fastapi import APIRouter, HTTPException, Response, UploadFile, status
from loguru import logger
from ultralytics import YOLO

from config import settings
from detectors import yolov8
from schemas.yolo import ImageAnalysisResponse

logfire.configure(service_name="routers")
logger.configure(handlers=[logfire.loguru_handler()])
logger.add("lpd_obb_api_v1.log", rotation="100 MB", compression="zip")

# A new router object that we can add endpoints to.
# Note that the prefix is /lp, so all endpoints from
# here on will be relative to /lp
router = APIRouter(tags=["Image Upload and analysis"], prefix="/lpd/api/v1")

# A cache of annotated images. Note that this would typically
# be some sort of persistent storage (think maybe postgres + S3)
# but for simplicity, we can keep things in memory
images = []

# Load the model once, when the server starts
# logger.info("Loading model")

lpd_obb_model = YOLO(settings.YOLO_WEIGHTS_PATH, task="obb")


@router.post(
    "/imgupload",
    status_code=status.HTTP_201_CREATED,
    responses={201: {"description": "Successfully Analyzed Image."}},
    response_model=ImageAnalysisResponse,
)
async def lpd_image_upload(file: UploadFile) -> ImageAnalysisResponse:
    """Takes a multi-part upload image and runs LPD OBB YOLO11 on it to detect the following objects
    Detection classes: 
        ['car_license_plate']
    
    Arguments: 
        file (UploadFile): The multi-part upload file
    
    Returns:
        response (ImageAnalysisResponse): The image ID and OBB polygons and others in the pydantic object

    Examlple cURL:
        curl -X 'POST' \
            'http://localhost/lpd/api/v1/imgupload' \
            -H 'accept: application/json' \
            -H 'Content-Type: multipart/form-data' \
            -F 'file=@image.jpg;type=image/jpeg'

    Example Return:
        {
            "success": true,
            "id": 1,
            "polygons": [
                [
                    [551.58, 358.88],
                    [1084.72, 360.10],
                    [1082.00, 452.92],
                    [549.10, 450.50]
                ]
            ],
            "confidences": [
                0.9543854594230652
            ],
            "classes": [
                "car_license_plate"
            ]
        }

        점 순서 규약: ultralytics OBB (top-left 시작, 시계방향 TL->TR->BR->BL), 픽셀 좌표.
    """
    # Read the uploaded file
    contents = await file.read()

    is_success = False
    # Run object detection inference
    dt = yolov8.YoloV8ImageObjectDetection(chunked=contents, model=lpd_obb_model)
    frame, polygons, confidences, classes = await dt()

    if polygons:
        is_success = True

    # Encode the processed image (optional, if you need to store or return it)
    _, encoded_image = cv2.imencode(".jpg", frame)
    images.append(encoded_image)

    # Create response object
    img_analysis_resp = ImageAnalysisResponse(
        success=is_success,
        id=len(images),
        polygons=polygons,
        confidences=confidences,
        classes=classes,
    )
    return img_analysis_resp


@router.get(
    "/resp/img_{image_id}",
    status_code=status.HTTP_200_OK,
    responses={
        200: {"content": {"image/jpeg": {}}},
        404: {"description": "Image ID Not Found."},
    },
    response_class=Response,
)
async def lpd_image_download(image_id: int) -> Response:
    """Takes an image id as a path param and returns that encoded
    image from the images array

    Arguments:
        image_id (int): The image ID to download
    
    Returns:
        response (Response): The encoded image in PNG format
    
    Examlple cURL:
        curl -X 'GET' \
            'http://localhost/lpd/api/v1/resp/img_1' \
            -H 'accept: image/jpeg'

    Example Return: A Binary Image
    """
    try:
        return Response(content=images[image_id - 1].tobytes(), media_type="image/jpeg")
    except IndexError:
        raise HTTPException(status_code=404, detail="Image not found")
