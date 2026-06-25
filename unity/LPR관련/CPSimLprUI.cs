using System;
using System.Collections.Generic;
using Newtonsoft.Json;
using UnityEngine;

public class CPSimLprUI : MonoBehaviour
{
    public const int DLINE_WIDTH = 2;

    public CLPRHelper m_LprHelper = null;

    [HideInInspector]
    public CImgOverlayMgr m_OverlayManager = null;
    private CPCamObjListUI m_CamObjListUI = null;


    public void Initialize(CPCamObjListUI kCamObjListUI)
    {
        m_CamObjListUI = kCamObjListUI;
    }

    public void SetURL(string serverUrl="")
    {
        m_LprHelper.Initialize(serverUrl);
    }

    // Start is called once before the first execution of Update after the MonoBehaviour is created
    void Start()
    {
        if( m_LprHelper == null )
            m_LprHelper = GetComponent<CLPRHelper>();
    }

    public void Start_LPR()
    {
        string sFileName = "";
        Texture2D kTexture = m_CamObjListUI.SaveCurViewerTexture(ref sFileName, "lpr");

        byte[] imgBytes = CImageHelper.TextureToByteArray(kTexture);

        string images = "";
        if (kTexture != null)
            images = CImageHelper.TextureToBase64(kTexture);

        m_LprHelper.SendLprData(imgBytes, sFileName, (result, isSuccess) =>
        {
            Debug.Log("Callback Result = " + result);
            if (!isSuccess)
            {
                Debug.Log("SendLprData...검지실패 !!!");
                return;
            }

            CUnityThread.executeInUpdate(() =>
            {
                ProcessLprResult(result, kTexture, images);
            });
        });
    }

    private void ProcessLprResult(string result, Texture2D kTexture, string images)
    {
        try
        {
            SLprData kResData = JsonConvert.DeserializeObject<SLprData>(result);
            List<SDetectionData> detections = new List<SDetectionData>();

            for (int i = 0; i < kResData.results.Count; i++)
            {
                SLprResult kItem = kResData.results[i];
                SDetectionData kData = new SDetectionData();
                kData.x1 = kItem.box.xmin;
                kData.y1 = kItem.box.ymin;
                kData.x2 = kItem.box.xmax;
                kData.y2 = kItem.box.ymax;
                kData.confidence = kItem.score;
                kData.class_id = 0;
                detections.Add(kData);
            }

            Debug.Log($"LPR 검지 결과: {detections.Count}개 박스 검출됨");

            EnsureOverlayManager();
            if (m_OverlayManager != null)
            {
                m_OverlayManager.CreateOverlays(detections, kTexture, Color.yellow, DLINE_WIDTH, "LPR");
                Debug.Log("LPR 오버레이 생성 완료");
            }
            else
            {
                Debug.LogError("m_OverlayManager가 null입니다!");
            }

            CPSimGameUI.SaveOverayImage(kTexture, detections, "Save/OverlayImages", "LPR");
        }
        catch (Exception ex)
        {
            Debug.LogError("ProcessLprResult 실패: " + ex.Message);
            Debug.LogError("Stack Trace: " + ex.StackTrace);
        }
    }

    private void EnsureOverlayManager()
    {
        if (m_OverlayManager != null)
        {
            Debug.Log("OverlayManager 이미 존재함");
            return;
        }

        if (m_CamObjListUI == null)
        {
            Debug.LogError("m_CamObjListUI가 null입니다!");
            return;
        }

        if (m_CamObjListUI.m_CurCamViewerUI == null)
        {
            Debug.LogError("m_CurCamViewerUI가 null입니다!");
            return;
        }

        var raw = m_CamObjListUI.m_CurCamViewerUI.m_RawImage;
        if (raw == null)
        {
            Debug.LogError("RawImage가 null입니다!");
            return;
        }

        Debug.Log("OverlayManager 초기화 시작");

        if (m_OverlayManager == null)
            m_OverlayManager = new CImgOverlayMgr();

        m_OverlayManager.Initialize(raw);
        Debug.Log("OverlayManager 초기화 완료");
    }
}
