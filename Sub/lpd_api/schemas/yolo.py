from typing import List

import logfire
from pydantic import BaseModel

logfire.instrument_pydantic()


class ImageAnalysisResponse(BaseModel):
    success: bool = False
    id: int
    # OBB 검출별 4점 폴리곤: [[[x0,y0],[x1,y1],[x2,y2],[x3,y3]], ...] (픽셀, TL->TR->BR->BL).
    polygons: List[List[List[float]]]
    confidences: List[float]
    classes: List[str]
