# PacketLabManager server launcher (PowerShell)
# Adds Npcap to PATH so cap.node can load wpcap.dll

if (Test-Path "C:\Windows\System32\Npcap") {
    $env:PATH = "C:\Windows\System32\Npcap;$env:PATH"
}
if (Test-Path "C:\Windows\SysWOW64\Npcap") {
    $env:PATH = "C:\Windows\SysWOW64\Npcap;$env:PATH"
}

node server.js @args
