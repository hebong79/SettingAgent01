// [LPR 검출 박스]
[Serializable]
public class SLPRBox
{
    public int xmin;
    public int ymin;
    public int xmax;
    public int ymax;
}

// [LPR 검출 데이터]
[System.Serializable]
public class SLprResult
{
    public string plate;                // 차량 번호판 문자열
    public float score;                 // 컨피던스(정확도: 1 = 100%)
    public SLPRBox box = new SLPRBox(); // 번호판 위치 박스
    public float[] candidates;          // 후보군 점수 배열
}


[System.Serializable]
public class SLprData
{
    public float processing_time;            // 처리 시간 (초)
    public List<SLprResult> results = new(); // 검출 결과
    public string filename;                  // 이미지 파일명
    public string version;                  // LPR 모델 버전
    public string camera_id;                // 카메라 ID
    public string timestamp;                // 타임스탬프
}