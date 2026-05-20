using System.IO.Ports;
using System.Management;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

namespace EthernetPacketGenerator.Services;

public class SerialPortService : IDisposable
{
    private SerialPort?            _port;
    private readonly StringBuilder _lineBuffer = new();
    private bool _disposed;

    private ManagementEventWatcher? _arrivalWatcher;
    private ManagementEventWatcher? _removalWatcher;

    // ── Command/Response 동기화 ──────────────────────────────────────────────
    private readonly SemaphoreSlim _cmdLock = new(1, 1);
    private volatile TaskCompletionSource<string>? _pendingResponse;

    // ── 멀티라인 응답 캡처 ───────────────────────────────────────────────────
    private volatile TaskCompletionSource<List<string>>? _pendingMultiLine;
    private readonly List<string> _multiLineBuffer = new();
    private readonly object _multiLineLock = new();

    // ── Events ───────────────────────────────────────────────────────────────
    public event Action<string>? LineReceived;
    public event Action<string>? ErrorOccurred;
    public event Action? PortListChanged;

    // ── Properties ───────────────────────────────────────────────────────────
    public bool IsOpen => _port?.IsOpen ?? false;

    // ── Port enumeration ─────────────────────────────────────────────────────
    public static IEnumerable<PortInfo> GetPortInfos()
    {
        var portNames = SerialPort.GetPortNames().ToHashSet();
        var nameMap   = new Dictionary<string, string>();

        try
        {
            using var searcher = new ManagementObjectSearcher(
                "SELECT Name FROM Win32_PnPEntity WHERE Name LIKE '%(COM%)'");

            foreach (ManagementObject obj in searcher.Get())
            {
                var name  = obj["Name"]?.ToString() ?? "";
                var match = Regex.Match(name, @"\(COM(\d+)\)");
                if (!match.Success) continue;

                var comPort   = $"COM{match.Groups[1].Value}";
                var shortName = name.Replace($" ({comPort})", "").Trim();
                nameMap[comPort] = shortName;
            }
        }
        catch { /* WMI 실패 시 포트 이름만 표시 */ }

        return portNames
            .OrderBy(p => p)
            .Select(p => nameMap.TryGetValue(p, out var n)
                ? new PortInfo(p, $"{p}  {n}")
                : new PortInfo(p, p));
    }

    // ── Open / Close ─────────────────────────────────────────────────────────
    public void Open(string portName, int baudRate,
                     Parity parity     = Parity.None,
                     int    dataBits   = 8,
                     StopBits stopBits = StopBits.One)
    {
        Close();

        _port = new SerialPort(portName, baudRate, parity, dataBits, stopBits)
        {
            ReadTimeout    = SerialPort.InfiniteTimeout,
            WriteTimeout   = 500,
            NewLine        = "\r\n",
            Encoding       = Encoding.ASCII,
            ReadBufferSize = 65536,
        };

        _port.DataReceived  += OnDataReceived;
        _port.ErrorReceived += OnPortError;
        _lineBuffer.Clear();
        _port.Open();
    }

    public void Close()
    {
        if (_port == null) return;

        _port.DataReceived  -= OnDataReceived;
        _port.ErrorReceived -= OnPortError;

        // 포트 닫힐 때 대기 중인 커맨드가 있으면 취소
        _pendingResponse?.TrySetException(new InvalidOperationException("포트가 닫혔습니다."));
        _pendingResponse = null;

        try
        {
            if (_port.IsOpen) _port.Close();
        }
        catch { /* 닫기 실패는 무시 */ }

        _port.Dispose();
        _port = null;
        _lineBuffer.Clear();
    }

    // ── Send ─────────────────────────────────────────────────────────────────
    public void SendLine(string command)
    {
        if (_port == null || !_port.IsOpen)
            throw new InvalidOperationException("포트가 열려있지 않습니다.");

        _port.WriteLine(command);
    }

    public void SendBytes(byte[] data)
    {
        if (_port == null || !_port.IsOpen)
            throw new InvalidOperationException("포트가 열려있지 않습니다.");

        _port.Write(data, 0, data.Length);
    }

    public void SetSignals(bool? rts = null, bool? dtr = null)
    {
        if (_port == null || !_port.IsOpen)
            throw new InvalidOperationException("포트가 열려있지 않습니다.");

        if (rts.HasValue) _port.RtsEnable = rts.Value;
        if (dtr.HasValue) _port.DtrEnable = dtr.Value;
    }

    public void SendBreak(int durationMs = 300)
    {
        if (_port == null || !_port.IsOpen)
            throw new InvalidOperationException("포트가 열려있지 않습니다.");

        _port.BreakState = true;
        Thread.Sleep(Math.Max(1, durationMs));
        _port.BreakState = false;
    }

    /// <summary>커맨드 전송 후 OK/ERR 응답 대기 (레지스터 R/W 전용)</summary>
    public async Task<string> SendCommandAsync(string command, int timeoutMs = 2000)
    {
        await _cmdLock.WaitAsync();
        try
        {
            var tcs = new TaskCompletionSource<string>(
                TaskCreationOptions.RunContinuationsAsynchronously);
            _pendingResponse = tcs;

            using var cts = new CancellationTokenSource(timeoutMs);
            cts.Token.Register(() =>
            {
                _pendingResponse = null;
                tcs.TrySetException(new TimeoutException("응답 시간 초과"));
            });

            SendLine(command);
            return await tcs.Task;
        }
        finally
        {
            _pendingResponse = null;
            _cmdLock.Release();
        }
    }

    /// <summary>커맨드 전송 후 여러 줄 응답 수집. "OK"/"ERR" 수신 또는 타임아웃 시 반환</summary>
    public async Task<List<string>> SendCommandMultiLineAsync(string command, int timeoutMs = 8000)
    {
        await _cmdLock.WaitAsync();
        try
        {
            lock (_multiLineLock) { _multiLineBuffer.Clear(); }

            var tcs = new TaskCompletionSource<List<string>>(
                TaskCreationOptions.RunContinuationsAsynchronously);
            _pendingMultiLine = tcs;

            using var cts = new CancellationTokenSource(timeoutMs);
            cts.Token.Register(() =>
            {
                if (_pendingMultiLine != tcs) return;
                _pendingMultiLine = null;
                List<string> snapshot;
                lock (_multiLineLock) { snapshot = new List<string>(_multiLineBuffer); }
                if (snapshot.Count > 0)
                    tcs.TrySetResult(snapshot);
                else
                    tcs.TrySetException(new TimeoutException("응답 시간 초과"));
            });

            SendLine(command);
            return await tcs.Task;
        }
        finally
        {
            _pendingMultiLine = null;
            _cmdLock.Release();
        }
    }

    // ── Receive ──────────────────────────────────────────────────────────────
    private void OnDataReceived(object sender, SerialDataReceivedEventArgs e)
    {
        if (_port == null) return;

        string data;
        try { data = _port.ReadExisting(); }
        catch { return; }

        foreach (char c in data)
        {
            if (c == '\n')
            {
                var line = _lineBuffer.ToString().TrimEnd('\r');
                _lineBuffer.Clear();

                if (string.IsNullOrEmpty(line)) continue;

                // 멀티라인 캡처 중이면 우선 처리
                if (_pendingMultiLine is { } ml)
                {
                    if (line.StartsWith("OK") || line.StartsWith("ERR"))
                    {
                        _pendingMultiLine = null;
                        List<string> result;
                        lock (_multiLineLock)
                        {
                            result = new List<string>(_multiLineBuffer);
                            _multiLineBuffer.Clear();
                        }
                        if (line.StartsWith("OK"))
                            ml.TrySetResult(result);
                        else
                            ml.TrySetException(new InvalidOperationException(line));
                    }
                    else
                    {
                        lock (_multiLineLock) { _multiLineBuffer.Add(line); }
                    }
                }
                // OK/ERR 응답은 pending command에 직접 전달 (background thread)
                else if ((line.StartsWith("OK") || line.StartsWith("ERR"))
                    && _pendingResponse is { } pending)
                {
                    _pendingResponse = null;
                    pending.TrySetResult(line);
                }
                else
                {
                    var captured = line;
                    System.Windows.Application.Current?.Dispatcher.Invoke(
                        () => LineReceived?.Invoke(captured));
                }
            }
            else
            {
                _lineBuffer.Append(c);
            }
        }
    }

    private void OnPortError(object sender, SerialErrorReceivedEventArgs e)
    {
        var msg = e.EventType switch
        {
            SerialError.Frame    => "프레임 오류 (보드레이트/스톱비트 불일치 가능성)",
            SerialError.Overrun  => "버퍼 오버런",
            SerialError.RXOver   => "수신 버퍼 초과",
            SerialError.RXParity => "패리티 오류",
            SerialError.TXFull   => "송신 버퍼 가득 참",
            _                    => $"알 수 없는 오류: {e.EventType}"
        };

        System.Windows.Application.Current?.Dispatcher.Invoke(
            () => ErrorOccurred?.Invoke(msg));
    }

    // ── Device watcher ───────────────────────────────────────────────────────
    public void StartDeviceWatcher()
    {
        StopDeviceWatcher();
        try
        {
            _arrivalWatcher = CreateWatcher("__InstanceCreationEvent");
            _arrivalWatcher.EventArrived += OnDeviceChanged;
            _arrivalWatcher.Start();

            _removalWatcher = CreateWatcher("__InstanceDeletionEvent");
            _removalWatcher.EventArrived += OnDeviceChanged;
            _removalWatcher.Start();
        }
        catch { /* WMI 미지원 환경에서 무시 */ }
    }

    public void StopDeviceWatcher()
    {
        if (_arrivalWatcher != null)
        {
            _arrivalWatcher.EventArrived -= OnDeviceChanged;
            _arrivalWatcher.Stop();
            _arrivalWatcher.Dispose();
            _arrivalWatcher = null;
        }
        if (_removalWatcher != null)
        {
            _removalWatcher.EventArrived -= OnDeviceChanged;
            _removalWatcher.Stop();
            _removalWatcher.Dispose();
            _removalWatcher = null;
        }
    }

    private static ManagementEventWatcher CreateWatcher(string eventType)
    {
        var query = new WqlEventQuery(
            eventType,
            TimeSpan.FromSeconds(1),
            "TargetInstance ISA 'Win32_PnPEntity' AND TargetInstance.Name LIKE '%(COM%)'");
        return new ManagementEventWatcher(query);
    }

    private void OnDeviceChanged(object sender, EventArrivedEventArgs e)
    {
        System.Windows.Application.Current?.Dispatcher.Invoke(
            () => PortListChanged?.Invoke());
    }

    // ── IDisposable ──────────────────────────────────────────────────────────
    public void Dispose()
    {
        if (_disposed) return;
        StopDeviceWatcher();
        Close();
        _disposed = true;
    }
}

/// <param name="PortName">실제 포트 이름 (예: COM3) — Open() 호출에 사용</param>
/// <param name="DisplayName">콤보박스에 표시할 이름 (예: COM3  USB Serial Device)</param>
public record PortInfo(string PortName, string DisplayName)
{
    public override string ToString() => DisplayName;
}
