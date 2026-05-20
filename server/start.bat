@echo off
REM PacketLabManager server launcher
REM Adds Npcap to PATH so cap.node can load wpcap.dll

if exist "C:\Windows\System32\Npcap" (
    set "PATH=C:\Windows\System32\Npcap;%PATH%"
)
if exist "C:\Windows\SysWOW64\Npcap" (
    set "PATH=C:\Windows\SysWOW64\Npcap;%PATH%"
)

node server.js %*
