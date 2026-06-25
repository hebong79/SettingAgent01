using System;
using System.IO;
using System.Net.Http;
using System.Threading.Tasks;
using UnityEngine;

/// <summary>
/// LPR 서버와 통신을 위한 Helper 클래스
/// </summary>
public class CLPRHelper : MonoBehaviour
{
    public const string LPR_SERVER_URL = "http://gobackdev.iptime.org:8124/v1/plate-reader/";
    public string m_ServerUrl = LPR_SERVER_URL;

    void Start()
    {
        //SendLprDataFromFile("./save/images/test01.png", (result)=>
        //{
        //    Debug.Log("Callback Result = " + result);
        //});
    }

    public void Initialize(string serverUrl = "")
    {
        if (!string.IsNullOrEmpty(serverUrl) || serverUrl !="localhost")
            m_ServerUrl = serverUrl;
    }

    //이미지 바이너리(byte[])과 파일명을 받아 전송하도록 수정
    public async void SendLprData(byte[] imageBytes, string fileName, Action<string, bool> OnResult = null)
    {
        if (imageBytes == null || imageBytes.Length == 0)
        {
            Debug.LogError("SendLprData: imageBytes is null or empty");
            OnResult?.Invoke(null, false);
            return;
        }

        try
        {
            using (var client = new HttpClient())
            using (var request = new HttpRequestMessage(HttpMethod.Post, LPR_SERVER_URL))
            using (var content = new MultipartFormDataContent())
            {
                var byteContent = new ByteArrayContent(imageBytes);
                // 필요하면 실제 MIME 타입(image/png 등)으로 변경 가능
                byteContent.Headers.ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue("application/octet-stream");

                // form field name "upload", 파일명 전달
                content.Add(byteContent, "upload", fileName ?? "image.bin");

                request.Content = content;

                var response = await client.SendAsync(request).ConfigureAwait(false);
                response.EnsureSuccessStatusCode();

                // 응답 본문을 문자열로 읽기
                var result = await response.Content.ReadAsStringAsync().ConfigureAwait(false);

                // Unity 콜백은 메인 스레드에서 호출되어야 하므로 Debug.Log와 콜백이 메인 스레드에서 안전하게 사용되는지 주의
                // 여기서는 콜백을 바로 호출
                OnResult?.Invoke(result, true);
                Debug.Log("LPR Result = " + result);
                
            }
        }
        catch (Exception ex)
        {
            Debug.LogWarning("SendLprData 실패: " + ex.Message);
            OnResult?.Invoke(null, false);
        }
        //return;
    }

    // 기존 파일 경로 기반 호출을 유지하고 싶으면 이 헬퍼를 사용
    public void SendLprDataFromFile(string pathName="./save/images/test01.png", Action<string, bool> OnResult = null)
    {
        if (string.IsNullOrEmpty(pathName) || !File.Exists(pathName))
        {
            Debug.LogError("SendLprDataFromFile: 파일을 찾을 수 없습니다: " + pathName);
            OnResult?.Invoke(null, false);
            return;
        }

        try
        {
            byte[] bytes = File.ReadAllBytes(pathName);
            string fileName = Path.GetFileName(pathName);
            SendLprData(bytes, fileName, OnResult);
        }
        catch (Exception ex)
        {
            Debug.LogError("파일 읽기 실패: " + ex.Message);
            OnResult?.Invoke(null, false);
        }
    }

    // 테스트용: 특정 경로의 파일을 서버로 전송
    public async void TestSendData(string sPathName="./save/images/test01.jpg")
    {
        var client = new HttpClient();
        var request = new HttpRequestMessage(HttpMethod.Post, LPR_SERVER_URL);
        var content = new MultipartFormDataContent();
        content.Add(new StreamContent(File.OpenRead(sPathName)), "upload", sPathName);
        request.Content = content;
        var response = await client.SendAsync(request);
        response.EnsureSuccessStatusCode();

        // 응답 본문을 문자열로 읽기
        string readTask = await response.Content.ReadAsStringAsync();

        Console.WriteLine(readTask);
    }
}
