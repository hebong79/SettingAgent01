from typing import List

import logfire
from pydantic import BaseModel

logfire.instrument_pydantic()


class ImageAnalysisResponse(BaseModel):
    success: bool = False
    id: int
    bboxes: List[List[float]]
    masks: List[List[List[int]]]
    confidences: List[float]
    classes: List[str]
