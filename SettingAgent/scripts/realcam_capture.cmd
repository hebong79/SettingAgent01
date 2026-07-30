@echo off
REM ParkAgent 18: scheduled daylight capture wrapper for real-camera-2.
REM Called by Windows Task Scheduler tasks "ParkAgent_RealCamDaylight_*".
REM   - cd /d fixes the working directory to SettingAgent (config/data paths are relative).
REM   - stdout+stderr are appended to reports\realcam_capture.log so failures leave a trace.
REM ASCII only on purpose: cmd.exe reads .cmd files in the OEM codepage, and UTF-8 Korean
REM comments get mis-decoded into stray command separators (observed: batch aborted on line 2).
REM Korean notes live in _workspace/02u_developer_changes_scheduled_capture.md.
cd /d "D:\Work\Parking3D\AgentVLA\ParkAgent\SettingAgent"
if not exist "reports" mkdir "reports"
call npx tsx src/tools/realCamCapture.ts >> "reports\realcam_capture.log" 2>&1
exit /b %ERRORLEVEL%
