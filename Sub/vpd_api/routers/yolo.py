import cv2
import logfire
from fastapi import APIRouter, HTTPException, Response, UploadFile, status
from loguru import logger
from ultralytics import YOLO

from config import settings
from detectors import yolo_infer
from schemas.yolo import ImageAnalysisResponse

logfire.configure(service_name="routers")
logger.configure(handlers=[logfire.loguru_handler()])
logger.add("vpd_api_v2.log", rotation="100 MB", compression="zip")

# A new router object that we can add endpoints to.
# Note that the prefix is /vpd/api/v2, so all endpoints from
# here on will be relative to /vpd/api/v2
router = APIRouter(tags=["Image Upload and analysis"], prefix="/vpd/api/v2")

# A cache of annotated images. Note that this would typically
# be some sort of persistent storage (think maybe postgres + S3)
# but for simplicity, we can keep things in memory
images = []

# Load the model once, when the server starts
# logger.info("Loading model")

vpd_det_model = YOLO(settings.YOLO_DET_WEIGHTS_PATH, task="detect")
vpd_seg_model = YOLO(settings.YOLO_SEG_WEIGHTS_PATH, task="segment")


@router.post(
    "/det/imgupload",
    status_code=status.HTTP_201_CREATED,
    responses={201: {"description": "Successfully Analyzed Image."}},
    response_model=ImageAnalysisResponse,
)
async def vpd_det_image_upload(file: UploadFile) -> ImageAnalysisResponse:
    """Takes a multi-part upload image and runs VPD YOLO11 on it to detect the following objects
    Detection classes: 
        ['car']
    
    Arguments: 
        file (UploadFile): The multi-part upload file
    
    Returns:
        response (ImageAnalysisResponse): The image ID and bboxes and others in the pydantic object
    
    Examlple cURL:
        curl -X 'POST' \
            'http://localhost/vpd/api/v2/det/imgupload' \
            -H 'accept: application/json' \
            -H 'Content-Type: multipart/form-data' \
            -F 'file=@image.jpg;type=image/jpeg'

    Example Return:
        {
            "success": true,
            "id": 1,
            "bboxes": [
                [
                    551.580322265625,
                    358.8811340332031,
                    1084.7222900390625,
                    452.9200744628906
                ]
            ],
            "confidence": [
                0.9543854594230652
            ],
            "classes": [
                "car"
            ]
        }
    """
    # Read the uploaded file
    contents = await file.read()

    is_success = False
    # Run object detection inference
    dt = yolo_infer.YoloV8ImageObjectDetection(chunked=contents, model=vpd_det_model, task="detect")
    frame, bboxes, masks, confidences, classes = await dt()

    if bboxes:
        is_success = True

    # Encode the processed image (optional, if you need to store or return it)
    _, encoded_image = cv2.imencode(".jpg", frame)
    images.append(encoded_image)

    # Create response object
    img_analysis_resp = ImageAnalysisResponse(
        success=is_success,
        id=len(images),
        bboxes=bboxes,
        masks=masks,
        confidences=confidences,
        classes=classes,
    )
    return img_analysis_resp


@router.post(
    "/seg/imgupload",
    status_code=status.HTTP_201_CREATED,
    responses={201: {"description": "Successfully Analyzed Image."}},
    response_model=ImageAnalysisResponse,
)
async def vpd_seg_image_upload(file: UploadFile) -> ImageAnalysisResponse:
    """Takes a multi-part upload image and runs VPD YOLO11 on it to segment the following objects
    Detection classes: 
        ['car']
    
    Arguments: 
        file (UploadFile): The multi-part upload file
    
    Returns:
        response (ImageAnalysisResponse): The image ID and bboxes and others in the pydantic object
    
    Examlple cURL:
        curl -X 'POST' \
            'http://localhost/vpd/api/v1/imgupload' \
            -H 'accept: application/json' \
            -H 'Content-Type: multipart/form-data' \
            -F 'file=@image.jpg;type=image/jpeg'

    Example Return:
        {
            "success": true,
            "id": 1,
            "bboxes": [
                [
                    551.580322265625,
                    358.8811340332031,
                    1084.7222900390625,
                    452.9200744628906
                ]
            ],
            "confidence": [
                0.9543854594230652
            ],
            "classes": [
                "car"
            ]
        }
    """
    # Read the uploaded file
    contents = await file.read()

    is_success = False
    # Run object detection inference
    dt = yolo_infer.YoloV8ImageObjectDetection(chunked=contents, model=vpd_seg_model, task="segment")
    frame, bboxes, masks, confidences, classes = await dt()

    if bboxes:
        is_success = True

    # Encode the processed image (optional, if you need to store or return it)
    _, encoded_image = cv2.imencode(".jpg", frame)
    images.append(encoded_image)

    # Create response object
    img_analysis_resp = ImageAnalysisResponse(
        success=is_success,
        id=len(images),
        bboxes=bboxes,
        masks=masks,
        confidences=confidences,
        classes=classes,
    )
    return img_analysis_resp


@router.get(
    "/resp/img_{image_id}",
    status_code=status.HTTP_200_OK,
    responses={
        200: {"content": {"image/jpg": {}}},
        404: {"description": "Image ID Not Found."},
    },
    response_class=Response,
)
async def vpd_image_download(image_id: int) -> Response:
    """Takes an image id as a path param and returns that encoded
    image from the images array

    Arguments:
        image_id (int): The image ID to download
    
    Returns:
        response (Response): The encoded image in JPG format
    
    Examlple cURL:
        curl -X 'GET' \
            'http://localhost/vpd/api/v2/resp/img_1' \
            -H 'accept: image/jpg'
    
    Example Return: A Binary Image
    """
    try:
        return Response(content=images[image_id - 1].tobytes(), media_type="image/jpg")
    except IndexError:
        raise HTTPException(status_code=404, detail="Image not found")
