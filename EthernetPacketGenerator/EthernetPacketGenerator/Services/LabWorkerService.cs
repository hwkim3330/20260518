using System.Collections.Concurrent;
using System.IO.Ports;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using EthernetPacketGenerator.Models;
using EthernetPacketGenerator.ViewModels;
using SharpPcap;

namespace EthernetPacketGenerator.Services;

/// <summary>
/// WebSocket worker client that connects to the Node.js lab manager server
/// at ws://localhost:8080/ws/worker?workerId=local and handles commands
/// dispatched through the workerHub protocol.
/// </summary>
public class LabWorkerService : IDisposable
{
    // ── Configuration ─────────────────────────────────────────────────────────
    private const int ReconnectDelayMs = 3000;
    private readonly string _serverUrl;
    private readonly string _workerId;
    private readonly string _serverBaseUrl;

    /// <summary>The base server URL (without path/query) passed at construction time.</summary>
    public string ServerUrl => _serverBaseUrl;

    /// <summary>The worker ID used when connecting to the server.</summary>
    public string WorkerId => _workerId;

    /// <summary>True while the WebSocket is in the Open state.</summary>
    public bool IsConnected { get; private set; }

    public LabWorkerService() : this("ws://localhost:8080", "local") { }

    public LabWorkerService(string serverUrl, string workerId = "local")
    {
        var b = (serverUrl ?? "ws://localhost:8080").TrimEnd('/');
        if (b.StartsWith("http://",  StringComparison.OrdinalIgnoreCase)) b = "ws://"  + b[7..];
        if (b.StartsWith("https://", StringComparison.OrdinalIgnoreCase)) b = "wss://" + b[8..];
        if (!b.StartsWith("ws://", StringComparison.OrdinalIgnoreCase) && !b.StartsWith("wss://", StringComparison.OrdinalIgnoreCase))
            b = "ws://" + b;
        _workerId      = workerId ?? "local";
        _serverBaseUrl = b;
        _serverUrl     = $"{b}/ws/worker?workerId={Uri.EscapeDataString(_workerId)}";
    }

    // ── WPF ViewModel references (set after window loads) ────────────────────
    public AutomationViewModel?    AutomationVm    { get; set; }
    public CaptureViewModel?       CaptureVm       { get; set; }
    public HyperTerminalViewModel? HyperTerminalVm { get; set; }

    private static readonly string?[] _tabIndexToView =
        { "senderView", "labView", "captureView", "captureView", "serialView", null };

    private MainViewModel? _mainVm;
    public MainViewModel? MainVm
    {
        get => _mainVm;
        set
        {
            if (_mainVm == value) return;
            if (_mainVm != null) _mainVm.PropertyChanged -= OnMainVmPropertyChanged;
            _mainVm = value;
            if (_mainVm != null) _mainVm.PropertyChanged += OnMainVmPropertyChanged;
        }
    }

    private void OnMainVmPropertyChanged(object? sender, System.ComponentModel.PropertyChangedEventArgs e)
    {
        if (e.PropertyName != nameof(MainViewModel.SelectedTabIndex)) return;
        var idx  = _mainVm?.SelectedTabIndex ?? 0;
        var view = (idx >= 0 && idx < _tabIndexToView.Length) ? _tabIndexToView[idx] : null;
        if (view == null) return;
        var payload = new JsonObject { ["kind"] = "tabchange", ["tabIndex"] = idx, ["view"] = view };
        _ = Task.Run(() => SendEventAsync(payload));
    }

    // ── WPF Dispatcher ────────────────────────────────────────────────────────
    private System.Windows.Threading.Dispatcher? _dispatcher;
    public System.Windows.Threading.Dispatcher? Dispatcher
    {
        get => _dispatcher;
        set => _dispatcher = value;
    }

    // ── Lifecycle ─────────────────────────────────────────────────────────────
    private CancellationTokenSource _cts = new();
    private Task?                   _runTask;
    private bool                    _disposed;

    // ── Capture state ─────────────────────────────────────────────────────────
    private readonly List<ILiveDevice> _captureDevices = new();
    private readonly ConcurrentQueue<JsonObject> _captureBuffer = new();
    private int _captureSeq;
    private volatile bool _isCapturing;

    // ── Serial state ──────────────────────────────────────────────────────────
    private SerialPort?       _serial;
    private readonly ConcurrentQueue<byte> _serialRxBuffer = new();

    // ── WebSocket send lock (single-writer requirement) ───────────────────────
    private readonly SemaphoreSlim _wsSendLock = new(1, 1);
    private ClientWebSocket? _ws;

    // ── JSON options ──────────────────────────────────────────────────────────
    private static readonly JsonSerializerOptions _jsonOpts = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };

    // =========================================================================
    // Public API
    // =========================================================================

    /// <summary>Start the background reconnect loop.</summary>
    public void Start()
    {
        if (_runTask != null) return;
        _runTask = RunAsync(_cts.Token);
    }

    /// <summary>Stop the reconnect loop, capture, and serial.</summary>
    public void Stop()
    {
        _cts.Cancel();
        IsConnected = false;
        StopCapture();
        CloseSerial();
    }

    /// <summary>Stop then restart the reconnect loop (used by SettingsViewModel reconnect command).</summary>
    public void Restart()
    {
        _cts.Cancel();
        IsConnected = false;
        _runTask = null;
        _cts = new CancellationTokenSource();
        Start();
    }

    // =========================================================================
    // Reconnect loop
    // =========================================================================

    private async Task RunAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try
            {
                using var ws = new ClientWebSocket();
                _ws = ws;
                await ws.ConnectAsync(new Uri(_serverUrl), ct);
                IsConnected = true;
                await ReceiveLoopAsync(ws, ct);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                break;
            }
            catch
            {
                // connection failed or dropped — wait and retry
            }
            finally
            {
                IsConnected = false;
                _ws = null;
            }

            if (!ct.IsCancellationRequested)
                await Task.Delay(ReconnectDelayMs, ct).ConfigureAwait(false);
        }
    }

    private async Task ReceiveLoopAsync(ClientWebSocket ws, CancellationToken ct)
    {
        var buf = new byte[64 * 1024];
        var sb  = new StringBuilder();

        while (ws.State == WebSocketState.Open && !ct.IsCancellationRequested)
        {
            sb.Clear();
            WebSocketReceiveResult result;
            do
            {
                result = await ws.ReceiveAsync(buf, ct);
                if (result.MessageType == WebSocketMessageType.Close)
                    return;
                sb.Append(Encoding.UTF8.GetString(buf, 0, result.Count));
            }
            while (!result.EndOfMessage);

            var msgJson = sb.ToString();
            _ = Task.Run(() => HandleMessageAsync(msgJson, ct), ct);
        }
    }

    // =========================================================================
    // Message dispatch
    // =========================================================================

    private async Task HandleMessageAsync(string json, CancellationToken ct)
    {
        JsonObject? msg;
        try { msg = JsonNode.Parse(json)?.AsObject(); }
        catch { return; }

        if (msg == null) return;

        var type    = msg["type"]?.GetValue<string>();
        var id      = msg["id"]?.GetValue<string>() ?? string.Empty;
        var command = msg["command"]?.GetValue<string>() ?? string.Empty;
        var payload = msg["payload"]?.AsObject() ?? new JsonObject();

        if (type != "command") return;

        try
        {
            var data = await DispatchAsync(command, payload, ct);
            await SendReplyAsync(id, true, data, ct);
        }
        catch (Exception ex)
        {
            await SendErrorReplyAsync(id, ex.Message, ct);
        }
    }

    private async Task<JsonObject> DispatchAsync(string command, JsonObject payload, CancellationToken ct)
    {
        return command.ToLowerInvariant() switch
        {
            "getinterfaces"  => GetInterfaces(),
            "build"          => await BuildAsync(payload),
            "send"           => await SendAsync(payload),
            "sendhex"        => await SendHexAsync(payload),
            "status"         => GetStatus(),
            "startcapture"   => await StartCaptureAsync(payload),
            "stopcapture"    => StopCaptureCmd(),
            "clearcapture"   => ClearCaptureCmd(),
            "getcaptures"    => GetCaptures(payload),
            "seriallist"     => SerialList(),
            "serialstatus"   => SerialStatus(),
            "serialopen"     => SerialOpen(payload),
            "serialclose"    => SerialClose(),
            "serialwrite"    => await SerialWriteAsync(payload),
            "serialread"     => SerialRead(),
            "serialclear"    => SerialClear(),
            "serialcontrol"  => SerialControl(payload),
            "registerstatus" => await RegisterStatusAsync(),
            "registerread"   => await RegisterReadAsync(payload),
            "registerwrite"  => await RegisterWriteAsync(payload),
            "fdbread"        => await FdbReadAsync(payload),
            "fdbwrite"       => await FdbWriteAsync(payload),
            "fdbdelete"      => await FdbDeleteAsync(payload),
            "fdbflush"       => await FdbFlushAsync(),
            "autorun"        => await AutoRunAsync(payload),
            "autostatus"     => await AutoStatusAsync(),
            "autoresults"    => await AutoResultsAsync(),
            "autostop"       => await AutoStopAsync(),
            "appstatus"      => await AppStatusAsync(),
            "testcasesstatus"       => await TestCasesStatusAsync(),
            "testcasesaddgroup"     => await TestCasesAddGroupAsync(payload),
            "testcasesadd"         => await TestCasesAddAsync(payload),
            "testcasesselect"      => await TestCasesSelectAsync(payload),
            "testcasessavecurrent" => await TestCasesSaveCurrentAsync(),
            "testcasesdelete"      => await TestCasesDeleteAsync(payload),
            "sequencestatus"       => await SequenceStatusAsync(),
            "sequencerun"          => await SequenceRunAsync(),
            "portslinkstatus"      => await PortsLinkStatusAsync(),
            "sequenceaddevent"     => await SequenceAddEventAsync(payload),
            "sequenceremoveevent"  => await SequenceRemoveEventAsync(payload),
            "sequenceclearevents"  => await SequenceClearEventsAsync(),
            "sequencegetfull"      => await SequenceGetFullAsync(),
            _ => throw new NotSupportedException($"Unknown command: {command}")
        };
    }

    // =========================================================================
    // Send helpers
    // =========================================================================

    private async Task SendReplyAsync(string replyTo, bool ok, JsonObject data, CancellationToken ct)
    {
        var msg = new JsonObject
        {
            ["type"]    = "reply",
            ["replyTo"] = replyTo,
            ["ok"]      = ok,
            ["data"]    = data
        };
        await SendRawAsync(msg.ToJsonString(), ct);
    }

    private async Task SendErrorReplyAsync(string replyTo, string error, CancellationToken ct)
    {
        var msg = new JsonObject
        {
            ["type"]    = "reply",
            ["replyTo"] = replyTo,
            ["ok"]      = false,
            ["error"]   = error
        };
        await SendRawAsync(msg.ToJsonString(), ct);
    }

    private async Task SendEventAsync(JsonObject eventPayload, CancellationToken ct = default)
    {
        var msg = new JsonObject
        {
            ["type"]    = "event",
            ["payload"] = eventPayload
        };
        await SendRawAsync(msg.ToJsonString(), ct);
    }

    private async Task SendRawAsync(string json, CancellationToken ct)
    {
        var ws = _ws;
        if (ws == null || ws.State != WebSocketState.Open) return;

        var bytes = Encoding.UTF8.GetBytes(json);
        await _wsSendLock.WaitAsync(ct);
        try
        {
            if (ws.State == WebSocketState.Open)
                await ws.SendAsync(bytes, WebSocketMessageType.Text, true, ct);
        }
        finally
        {
            _wsSendLock.Release();
        }
    }

    // =========================================================================
    // Command: getinterfaces
    // =========================================================================

    private JsonObject GetInterfaces()
    {
        var nics = NetworkInterface.GetAllNetworkInterfaces();
        var list = new JsonArray();

        foreach (var nic in nics)
        {
            var macBytes = nic.GetPhysicalAddress().GetAddressBytes();
            var macStr   = macBytes.Length == 6
                ? string.Join(":", macBytes.Select(b => b.ToString("x2")))
                : string.Empty;

            var addrs = new JsonArray();
            foreach (var ua in nic.GetIPProperties().UnicastAddresses)
            {
                if (ua.Address.AddressFamily == AddressFamily.InterNetwork)
                    addrs.Add(new JsonObject
                    {
                        ["local"]     = ua.Address.ToString(),
                        ["prefixlen"] = ua.PrefixLength
                    });
            }

            list.Add(new JsonObject
            {
                ["name"]  = nic.Name,
                ["key"]   = nic.Name,
                ["mac"]   = macStr,
                ["state"] = nic.OperationalStatus == OperationalStatus.Up ? "up" : "down",
                ["mtu"]   = nic.GetIPProperties().GetIPv4Properties()?.Mtu ?? 0,
                ["ipv4"]  = addrs,
                ["description"] = nic.Description
            });
        }

        return new JsonObject { ["interfaces"] = list };
    }

    // =========================================================================
    // Command: build
    // =========================================================================

    private Task<JsonObject> BuildAsync(JsonObject payload)
    {
        var profile = NormalizeProfile(payload);
        var (_, decoded) = LabPacketService.BuildFrame(profile);
        return Task.FromResult(new JsonObject { ["decoded"] = decoded });
    }

    // =========================================================================
    // Command: send
    // =========================================================================

    private async Task<JsonObject> SendAsync(JsonObject payload)
    {
        var profile    = NormalizeProfile(payload);
        var ifaceName  = profile["interface"]?.GetValue<string>() ?? string.Empty;
        var count      = profile["count"]?.GetValue<int>() ?? 1;
        var intervalMs = profile["intervalMs"]?.GetValue<int>() ?? 0;

        // Auto-fill srcMac from OS NIC if not provided
        if (string.IsNullOrWhiteSpace(profile["srcMac"]?.GetValue<string>()))
        {
            var nics = NetworkInterface.GetAllNetworkInterfaces();
            var nic  = nics.FirstOrDefault(n => n.Name.Equals(ifaceName, StringComparison.OrdinalIgnoreCase));
            if (nic != null)
            {
                var mb = nic.GetPhysicalAddress().GetAddressBytes();
                if (mb.Length == 6) profile["srcMac"] = string.Join(":", mb.Select(b => b.ToString("x2")));
            }
            if (string.IsNullOrWhiteSpace(profile["srcMac"]?.GetValue<string>()))
            {
                var devMac = FindDevice(ifaceName)?.MacAddress?.GetAddressBytes();
                if (devMac?.Length == 6) profile["srcMac"] = string.Join(":", devMac.Select(b => b.ToString("x2")));
            }
        }

        var (frame, decoded) = LabPacketService.BuildFrame(profile);

        var dev = FindDevice(ifaceName);
        if (dev == null)
            throw new InvalidOperationException($"Interface not found: {ifaceName}");

        int  framesSent  = 0;
        long bytesSent   = 0;

        // Skip Open() if device is already open for capture (avoids deadlock)
        bool alreadyOpen = _captureDevices.Contains(dev);
        if (!alreadyOpen)
        {
            try { dev.Open(DeviceModes.None); }
            catch { alreadyOpen = true; }
        }

        try
        {
            for (int i = 0; i < count; i++)
            {
                dev.SendPacket(frame);
                framesSent++;
                bytesSent += frame.Length;
                if (intervalMs > 0 && i < count - 1)
                    await Task.Delay(intervalMs);
            }
        }
        finally
        {
            if (!alreadyOpen)
            {
                try { dev.Close(); } catch { }
            }
        }

        var stdout = new JsonObject
        {
            ["framesSent"] = framesSent,
            ["bytesSent"]  = bytesSent,
            ["decoded"]    = decoded.ToJsonString()
        };

        return new JsonObject
        {
            ["framesSent"] = framesSent,
            ["bytesSent"]  = bytesSent,
            ["decoded"]    = decoded,
            ["stdout"]     = stdout
        };
    }

    // =========================================================================
    // Command: sendhex
    // =========================================================================

    private async Task<JsonObject> SendHexAsync(JsonObject payload)
    {
        var hex       = (payload["hex"]?.GetValue<string>() ?? "").Replace(" ", "").Replace(":", "");
        var ifaceName = payload["interface"]?.GetValue<string>() ?? string.Empty;
        var count     = payload["count"]?.GetValue<int>() ?? 1;

        var frame = Convert.FromHexString(hex);

        var dev = FindDevice(ifaceName);
        if (dev == null)
            throw new InvalidOperationException($"Interface not found: {ifaceName}");

        int framesSent = 0;
        long bytesSent = 0;

        bool alreadyOpen = _captureDevices.Contains(dev);
        if (!alreadyOpen)
        {
            try { dev.Open(DeviceModes.None); }
            catch { alreadyOpen = true; }
        }

        try
        {
            for (int i = 0; i < count; i++)
            {
                dev.SendPacket(frame);
                framesSent++;
                bytesSent += frame.Length;
            }
        }
        finally
        {
            if (!alreadyOpen)
            {
                try { dev.Close(); } catch { }
            }
        }

        await Task.CompletedTask;
        return new JsonObject { ["framesSent"] = framesSent, ["bytesSent"] = bytesSent };
    }

    // =========================================================================
    // Command: status
    // =========================================================================

    private JsonObject GetStatus()
    {
        var nics = NetworkInterface.GetAllNetworkInterfaces();
        var captureIfaceNames = new JsonArray();
        foreach (var dev in _captureDevices)
        {
            var mac = dev.MacAddress?.GetAddressBytes();
            if (mac?.Length == 6)
            {
                var nic = nics.FirstOrDefault(n => n.GetPhysicalAddress().GetAddressBytes().SequenceEqual(mac));
                if (nic != null) captureIfaceNames.Add(nic.Name);
                else             captureIfaceNames.Add(dev.Name);
            }
            else captureIfaceNames.Add(dev.Name);
        }
        return new JsonObject
        {
            ["workerId"]          = _workerId,
            ["capturing"]         = _isCapturing,
            ["captureCount"]      = _captureBuffer.Count,
            ["captureInterfaces"] = captureIfaceNames
        };
    }

    // =========================================================================
    // Command: startcapture
    // =========================================================================

    private async Task<JsonObject> StartCaptureAsync(JsonObject payload)
    {
        StopCapture();

        var ifaceNames = payload["interfaces"]?.AsArray()
            .Select(n => n?.GetValue<string>() ?? string.Empty)
            .Where(s => !string.IsNullOrWhiteSpace(s))
            .ToList() ?? new List<string>();

        // Accept bpfFilter or filter field from payload
        var bpfFilter = payload["bpfFilter"]?.GetValue<string>()
                     ?? payload["filter"]?.GetValue<string>()
                     ?? string.Empty;

        _captureSeq = 0;
        var captureStart = DateTime.Now;
        var ct = _cts.Token;

        foreach (var dev in CaptureDeviceList.Instance)
        {
            var match = ifaceNames.Count == 0 || MatchDevice(dev, ifaceNames);
            if (!match) continue;

            try
            {
                dev.OnPacketArrival += (sender, e) => OnCaptureArrival(sender, e, captureStart, ct);
                dev.Open(DeviceModes.Promiscuous, 1000);

                // Apply BPF filter at kernel level if provided
                if (!string.IsNullOrWhiteSpace(bpfFilter))
                {
                    try { dev.Filter = bpfFilter; } catch { /* ignore invalid filter — capture all */ }
                }

                dev.StartCapture();
                _captureDevices.Add(dev);
            }
            catch
            {
                try { dev.OnPacketArrival -= (sender, e) => OnCaptureArrival(sender, e, captureStart, ct); } catch { }
            }
        }

        _isCapturing = true;
        await Task.CompletedTask;

        return new JsonObject
        {
            ["capturing"]  = _isCapturing,
            ["interfaces"] = _captureDevices.Count,
            ["bpfFilter"]  = bpfFilter
        };
    }

    private bool MatchDevice(ILiveDevice dev, List<string> names)
    {
        foreach (var name in names)
        {
            if (dev.Name.Contains(name, StringComparison.OrdinalIgnoreCase)) return true;
            if ((dev.Description ?? "").Contains(name, StringComparison.OrdinalIgnoreCase)) return true;

            // match by MAC
            var macBytes = dev.MacAddress?.GetAddressBytes();
            if (macBytes?.Length == 6)
            {
                var macStr = string.Join(":", macBytes.Select(b => b.ToString("x2")));
                if (macStr.Equals(name, StringComparison.OrdinalIgnoreCase)) return true;
            }

            // match by OS NIC name
            var nics = NetworkInterface.GetAllNetworkInterfaces();
            var mac  = dev.MacAddress?.GetAddressBytes();
            if (mac?.Length == 6)
            {
                var nic = nics.FirstOrDefault(n => n.GetPhysicalAddress().GetAddressBytes().SequenceEqual(mac));
                if (nic != null && nic.Name.Equals(name, StringComparison.OrdinalIgnoreCase)) return true;
            }
        }
        return false;
    }

    private void OnCaptureArrival(object sender, PacketCapture e, DateTime captureStart, CancellationToken ct)
    {
        if (ct.IsCancellationRequested) return;

        var raw      = e.GetPacket();
        var no       = Interlocked.Increment(ref _captureSeq);
        var ts       = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() / 1000.0;
        var iface    = ResolveDeviceName(sender as ILiveDevice);
        var frameHex = Convert.ToHexString(raw.Data).ToLowerInvariant();

        var decoded = DecodeBytes(raw.Data);

        var record = new JsonObject
        {
            ["no"]        = no,
            ["timestamp"] = ts,
            ["interface"] = iface,
            ["length"]    = raw.Data.Length,
            ["frameHex"]  = frameHex,
            ["decoded"]   = decoded
        };

        _captureBuffer.Enqueue(record);

        // keep buffer bounded
        while (_captureBuffer.Count > 10000)
            _captureBuffer.TryDequeue(out _);

        var eventPayload = new JsonObject
        {
            ["kind"]   = "capture",
            ["record"] = record.DeepClone().AsObject()
        };

        _ = Task.Run(() => SendEventAsync(eventPayload, ct), ct);
    }

    private string ResolveDeviceName(ILiveDevice? dev)
    {
        if (dev == null) return "unknown";

        var mac = dev.MacAddress?.GetAddressBytes();
        if (mac?.Length == 6)
        {
            var nic = NetworkInterface.GetAllNetworkInterfaces()
                .FirstOrDefault(n => n.GetPhysicalAddress().GetAddressBytes().SequenceEqual(mac));
            if (nic != null) return nic.Name;
        }

        return string.IsNullOrWhiteSpace(dev.Description) ? dev.Name : dev.Description;
    }

    // =========================================================================
    // Command: stopcapture
    // =========================================================================

    private JsonObject StopCaptureCmd()
    {
        StopCapture();
        return new JsonObject { ["capturing"] = false };
    }

    private void StopCapture()
    {
        foreach (var dev in _captureDevices.ToList())
        {
            try { dev.StopCapture(); } catch { }
            try { dev.Close(); } catch { }
        }
        _captureDevices.Clear();
        _isCapturing = false;
    }

    // =========================================================================
    // Command: clearcapture
    // =========================================================================

    private JsonObject ClearCaptureCmd()
    {
        while (_captureBuffer.TryDequeue(out _)) { }
        _captureSeq = 0;
        return new JsonObject { ["cleared"] = true };
    }

    // =========================================================================
    // Command: getcaptures
    // =========================================================================

    private JsonObject GetCaptures(JsonObject? payload = null)
    {
        var limit  = payload?["limit"] ?.GetValue<int>() is { } l && l > 0 ? l : 10000;
        var offset = payload?["offset"]?.GetValue<int>() is { } o && o >= 0 ? o : 0;

        var all   = _captureBuffer.ToArray();   // snapshot; order = arrival order
        var slice = all.Skip(offset).Take(limit).ToArray();

        var arr = new JsonArray();
        foreach (var p in slice) arr.Add(p.DeepClone());
        return new JsonObject { ["rows"] = arr, ["total"] = all.Length };
    }

    // =========================================================================
    // Packet decoder
    // =========================================================================

    private static JsonObject DecodeBytes(byte[] f)
    {
        return LabPacketService.DecodeFrame(f);
    }

    // =========================================================================
    // Serial commands
    // =========================================================================

    private JsonObject SerialList()
    {
        if (HyperTerminalVm != null)
        {
            return DispatchToUiAsync(() =>
            {
                HyperTerminalVm.RefreshPortsForApi();
                var snapshot = HyperTerminalVm.GetSnapshot();
                return new JsonObject { ["terminal"] = JsonNode.Parse(JsonSerializer.Serialize(snapshot, _jsonOpts)) };
            }).GetAwaiter().GetResult();
        }

        var ports = SerialPort.GetPortNames().OrderBy(p => p).ToArray();
        var ttys  = new JsonArray();
        var ptys  = new JsonArray();
        foreach (var p in ports)
        {
            ttys.Add(new JsonObject { ["path"] = p, ["name"] = p });
            ptys.Add(new JsonObject { ["path"] = p, ["name"] = p });
        }
        return new JsonObject { ["ttys"] = ttys, ["ports"] = ptys };
    }

    private JsonObject SerialStatus()
    {
        if (HyperTerminalVm != null)
        {
            return DispatchToUiAsync(() =>
            {
                var snapshot = HyperTerminalVm.GetSnapshot();
                return new JsonObject { ["terminal"] = JsonNode.Parse(JsonSerializer.Serialize(snapshot, _jsonOpts)) };
            }).GetAwaiter().GetResult();
        }

        var ports = SerialPort.GetPortNames().OrderBy(p => p).ToArray();

        JsonArray MakeArr() {
            var a = new JsonArray();
            foreach (var p in ports) a.Add(new JsonObject { ["path"] = p, ["name"] = p });
            return a;
        }

        if (_serial == null || !_serial.IsOpen)
            return new JsonObject { ["open"] = false, ["connected"] = false, ["ttys"] = MakeArr(), ["ports"] = MakeArr() };

        return new JsonObject
        {
            ["open"]      = true,
            ["connected"] = true,
            ["port"]      = _serial.PortName,
            ["path"]      = _serial.PortName,
            ["baudRate"]  = _serial.BaudRate,
            ["dataBits"]  = _serial.DataBits,
            ["parity"]    = _serial.Parity.ToString(),
            ["stopBits"]  = _serial.StopBits.ToString(),
            ["rts"]       = _serial.RtsEnable,
            ["dtr"]       = _serial.DtrEnable,
            ["ttys"]      = MakeArr(),
            ["ports"]     = MakeArr()
        };
    }

    private JsonObject SerialOpen(JsonObject payload)
    {
        var port     = payload["port"]?.GetValue<string>()     ?? throw new ArgumentException("port required");
        var baudRate = payload["baudRate"]?.GetValue<int>()     ?? 115200;
        var dataBits = payload["dataBits"]?.GetValue<int>()    ?? 8;
        var parity   = payload["parity"]?.GetValue<string>()   ?? "None";
        var stopBits = payload["stopBits"]?.GetValue<string>()  ?? "One";

        if (HyperTerminalVm != null)
        {
            return DispatchToUiAsync(() =>
            {
                HyperTerminalVm.ConnectForApi(port, baudRate);
                var snapshot = HyperTerminalVm.GetSnapshot();
                return new JsonObject
                {
                    ["open"] = true,
                    ["port"] = port,
                    ["baudRate"] = baudRate,
                    ["terminal"] = JsonNode.Parse(JsonSerializer.Serialize(snapshot, _jsonOpts))
                };
            }).GetAwaiter().GetResult();
        }

        CloseSerial();

        _serial = new SerialPort
        {
            PortName  = port,
            BaudRate  = baudRate,
            DataBits  = dataBits,
            Parity    = Enum.TryParse<Parity>(parity, true, out var p) ? p : Parity.None,
            StopBits  = Enum.TryParse<StopBits>(stopBits, true, out var s) ? s : StopBits.One,
            ReadTimeout  = 500,
            WriteTimeout = 500
        };

        _serial.DataReceived += OnSerialDataReceived;
        _serial.Open();

        return new JsonObject { ["open"] = true, ["port"] = port, ["baudRate"] = baudRate };
    }

    private JsonObject SerialClose()
    {
        if (HyperTerminalVm != null)
        {
            return DispatchToUiAsync(() =>
            {
                HyperTerminalVm.DisconnectForApi();
                var snapshot = HyperTerminalVm.GetSnapshot();
                return new JsonObject
                {
                    ["open"] = false,
                    ["terminal"] = JsonNode.Parse(JsonSerializer.Serialize(snapshot, _jsonOpts))
                };
            }).GetAwaiter().GetResult();
        }

        CloseSerial();
        return new JsonObject { ["open"] = false };
    }

    private void CloseSerial()
    {
        if (_serial == null) return;
        try
        {
            _serial.DataReceived -= OnSerialDataReceived;
            if (_serial.IsOpen) _serial.Close();
            _serial.Dispose();
        }
        catch { }
        finally { _serial = null; }
    }

    private void OnSerialDataReceived(object sender, SerialDataReceivedEventArgs e)
    {
        if (_serial == null || !_serial.IsOpen) return;
        try
        {
            var bytes = new byte[_serial.BytesToRead];
            _serial.Read(bytes, 0, bytes.Length);

            foreach (var b in bytes)
                _serialRxBuffer.Enqueue(b);

            // keep buffer bounded
            while (_serialRxBuffer.Count > 65536)
                _serialRxBuffer.TryDequeue(out _);

            var hex = Convert.ToHexString(bytes).ToLowerInvariant();
            var port = _serial.PortName;

            var eventPayload = new JsonObject
            {
                ["kind"]    = "serial",
                ["rxType"]  = "rx",
                ["hex"]     = hex,
                ["session"] = port
            };

            _ = Task.Run(() => SendEventAsync(eventPayload));
        }
        catch { }
    }

    private async Task<JsonObject> SerialWriteAsync(JsonObject payload)
    {
        if (HyperTerminalVm != null)
        {
            return await DispatchToUiAsync(() =>
            {
                var hex  = payload["hex"]?.GetValue<string>();
                var text = payload["text"]?.GetValue<string>();

                if (hex != null)
                {
                    var bytes = Convert.FromHexString(hex.Replace(" ", "").Replace(":", ""));
                    HyperTerminalVm.SendBytesForApi(bytes);
                    return new JsonObject { ["written"] = bytes.Length, ["mode"] = "hex" };
                }

                if (text != null)
                {
                    HyperTerminalVm.SendForApi(text);
                    return new JsonObject { ["written"] = text.Length, ["mode"] = "text" };
                }

                throw new ArgumentException("Either hex or text payload is required");
            });
        }

        if (_serial == null || !_serial.IsOpen)
            throw new InvalidOperationException("Serial port not open");

        var hex  = payload["hex"]?.GetValue<string>();
        var text = payload["text"]?.GetValue<string>();

        if (hex != null)
        {
            var bytes = Convert.FromHexString(hex.Replace(" ", "").Replace(":", ""));
            _serial.Write(bytes, 0, bytes.Length);
            await Task.CompletedTask;
            return new JsonObject { ["written"] = bytes.Length, ["mode"] = "hex" };
        }
        else if (text != null)
        {
            _serial.Write(text);
            await Task.CompletedTask;
            return new JsonObject { ["written"] = text.Length, ["mode"] = "text" };
        }

        throw new ArgumentException("Either hex or text payload is required");
    }

    private JsonObject SerialRead()
    {
        if (HyperTerminalVm != null)
        {
            return DispatchToUiAsync(() =>
            {
                var snapshot = HyperTerminalVm.GetSnapshot();
                return new JsonObject { ["terminal"] = JsonNode.Parse(JsonSerializer.Serialize(snapshot, _jsonOpts)) };
            }).GetAwaiter().GetResult();
        }

        var bytes = _serialRxBuffer.ToArray();
        while (_serialRxBuffer.TryDequeue(out _)) { }
        var hex = Convert.ToHexString(bytes).ToLowerInvariant();
        return new JsonObject { ["hex"] = hex, ["length"] = bytes.Length };
    }

    private JsonObject SerialClear()
    {
        if (HyperTerminalVm != null)
        {
            return DispatchToUiAsync(() =>
            {
                HyperTerminalVm.ClearForApi();
                var snapshot = HyperTerminalVm.GetSnapshot();
                return new JsonObject
                {
                    ["cleared"] = true,
                    ["terminal"] = JsonNode.Parse(JsonSerializer.Serialize(snapshot, _jsonOpts))
                };
            }).GetAwaiter().GetResult();
        }

        while (_serialRxBuffer.TryDequeue(out _)) { }
        return new JsonObject { ["cleared"] = true };
    }

    private JsonObject SerialControl(JsonObject payload)
    {
        if (HyperTerminalVm != null)
        {
            return DispatchToUiAsync(() =>
            {
                var cmd = payload["cmd"]?.GetValue<string>() ?? "";
                bool? rts = payload.ContainsKey("rts") ? payload["rts"]!.GetValue<bool>() : null;
                bool? dtr = payload.ContainsKey("dtr") ? payload["dtr"]!.GetValue<bool>() : null;
                HyperTerminalVm.ControlForApi(cmd, rts, dtr);
                var snapshot = HyperTerminalVm.GetSnapshot();
                return new JsonObject
                {
                    ["ok"] = true,
                    ["terminal"] = JsonNode.Parse(JsonSerializer.Serialize(snapshot, _jsonOpts))
                };
            }).GetAwaiter().GetResult();
        }

        if (_serial == null || !_serial.IsOpen)
            throw new InvalidOperationException("Serial port not open");

        var cmd = payload["cmd"]?.GetValue<string>() ?? "";
        if (cmd.Equals("break", StringComparison.OrdinalIgnoreCase))
        {
            _serial.BreakState = true;
            System.Threading.Thread.Sleep(300);
            _serial.BreakState = false;
            return new JsonObject { ["break"] = true };
        }

        if (payload.ContainsKey("rts"))
            _serial.RtsEnable = payload["rts"]!.GetValue<bool>();
        if (payload.ContainsKey("dtr"))
            _serial.DtrEnable = payload["dtr"]!.GetValue<bool>();

        return new JsonObject
        {
            ["rts"] = _serial.RtsEnable,
            ["dtr"] = _serial.DtrEnable
        };
    }

    // =========================================================================
    // Register commands (via Dispatcher + HyperTerminalVm.RegisterViewerVM)
    // =========================================================================

    private async Task<JsonObject> RegisterStatusAsync()
    {
        var (baseAddr, connected) = await DispatchToUiAsync(() =>
        {
            var htVm = RequireHyperTerminalVm();
            return (htVm.RegisterViewerVM.BaseAddressHex, htVm.IsConnected);
        });
        return new JsonObject { ["baseAddress"] = baseAddr, ["connected"] = connected };
    }

    private async Task<JsonObject> RegisterReadAsync(JsonObject payload)
    {
        var offset = ParseUint(payload["offset"]?.GetValue<string>() ?? payload["offset"]?.GetValue<uint>().ToString() ?? "0");
        var regVm  = await DispatchToUiAsync(() => RequireHyperTerminalVm().RegisterViewerVM);
        var value  = await regVm.ReadRegisterForApiAsync(offset);
        return new JsonObject { ["offset"] = $"0x{offset:X8}", ["value"] = $"0x{value:X8}", ["valueNum"] = value };
    }

    private async Task<JsonObject> RegisterWriteAsync(JsonObject payload)
    {
        var offset = ParseUint(payload["offset"]?.GetValue<string>() ?? "0");
        var value  = ParseUint(payload["value"]?.GetValue<string>()  ?? "0");
        var regVm  = await DispatchToUiAsync(() => RequireHyperTerminalVm().RegisterViewerVM);
        await regVm.WriteRegisterForApiAsync(offset, value);
        return new JsonObject { ["offset"] = $"0x{offset:X8}", ["value"] = $"0x{value:X8}" };
    }

    // =========================================================================
    // FDB commands
    // =========================================================================

    private async Task<JsonObject> FdbReadAsync(JsonObject payload)
    {
        var mac       = payload["mac"]?.GetValue<string>()       ?? throw new ArgumentException("mac required");
        var vlanValid = payload["vlanValid"]?.GetValue<bool>()   ?? false;
        var vlanId    = payload["vlanId"]?.GetValue<int>()       ?? 0;
        var regVm     = await DispatchToUiAsync(() => RequireHyperTerminalVm().RegisterViewerVM);
        var entry     = await regVm.FdbReadByMacForApiAsync(mac, vlanValid, vlanId);
        return new JsonObject { ["entry"] = entry == null ? null : JsonNode.Parse(JsonSerializer.Serialize(entry, _jsonOpts)) };
    }

    private async Task<JsonObject> FdbWriteAsync(JsonObject payload)
    {
        var mac       = payload["mac"]?.GetValue<string>()       ?? throw new ArgumentException("mac required");
        var vlanValid = payload["vlanValid"]?.GetValue<bool>()   ?? false;
        var vlanId    = payload["vlanId"]?.GetValue<int>()       ?? 0;
        var port      = payload["port"]?.GetValue<int>()         ?? 0;
        var regVm     = await DispatchToUiAsync(() => RequireHyperTerminalVm().RegisterViewerVM);
        await regVm.FdbWriteByMacForApiAsync(mac, vlanValid, vlanId, port);
        return new JsonObject { ["ok"] = true };
    }

    private async Task<JsonObject> FdbDeleteAsync(JsonObject payload)
    {
        var mac       = payload["mac"]?.GetValue<string>()       ?? throw new ArgumentException("mac required");
        var vlanValid = payload["vlanValid"]?.GetValue<bool>()   ?? false;
        var vlanId    = payload["vlanId"]?.GetValue<int>()       ?? 0;
        var regVm     = await DispatchToUiAsync(() => RequireHyperTerminalVm().RegisterViewerVM);
        await regVm.FdbDeleteByMacForApiAsync(mac, vlanValid, vlanId);
        return new JsonObject { ["ok"] = true };
    }

    private async Task<JsonObject> FdbFlushAsync()
    {
        var regVm = await DispatchToUiAsync(() => RequireHyperTerminalVm().RegisterViewerVM);
        await regVm.FdbFlushForApiAsync();
        return new JsonObject { ["ok"] = true };
    }

    // =========================================================================
    // Automation commands
    // =========================================================================

    private async Task<JsonObject> AutoRunAsync(JsonObject payload)
    {
        var test = payload["test"]?.GetValue<string>() ?? throw new ArgumentException("test required");
        var autoVm = await DispatchToUiAsync(() => RequireAutomationVm());
        await autoVm.RunTestAsync(test);
        return new JsonObject { ["ok"] = true, ["test"] = test };
    }

    private async Task<JsonObject> AutoStatusAsync()
    {
        var (running, result, status) = await DispatchToUiAsync(() =>
        {
            var vm = RequireAutomationVm();
            return (vm.IsRunning, vm.FinalResult, vm.StatusText);
        });
        return new JsonObject { ["running"] = running, ["result"] = result, ["statusText"] = status };
    }

    private async Task<JsonObject> AutoResultsAsync()
    {
        var rows = await DispatchToUiAsync(() => RequireAutomationVm().GetResultsSnapshot());
        var arr  = JsonNode.Parse(JsonSerializer.Serialize(rows, _jsonOpts))?.AsArray() ?? new JsonArray();
        return new JsonObject { ["rows"] = arr };
    }

    private async Task<JsonObject> AutoStopAsync()
    {
        await DispatchToUiAsync<bool>(() => { RequireAutomationVm().StopTest(); return true; });
        return new JsonObject { ["ok"] = true };
    }

    // =========================================================================
    // App / sequence status commands
    // =========================================================================

    private async Task<JsonObject> AppStatusAsync()
    {
        var (tabIndex, seqCount) = await DispatchToUiAsync(() =>
        {
            var vm = RequireMainVm();
            return (vm.SelectedTabIndex, vm.PacketListVM.Sequence.Count);
        });
        return new JsonObject { ["selectedTabIndex"] = tabIndex, ["sequenceCount"] = seqCount };
    }

    private async Task<JsonObject> TestCasesStatusAsync()
    {
        var snapshot = await DispatchToUiAsync(() =>
        {
            var vm = RequireMainVm();
            return vm.TestCaseMgrVM.GetSnapshotForApi();
        });
        return new JsonObject { ["snapshot"] = JsonNode.Parse(JsonSerializer.Serialize(snapshot, _jsonOpts)) };
    }

    private async Task<JsonObject> SequenceStatusAsync()
    {
        var items = await DispatchToUiAsync(() =>
        {
            var vm = RequireMainVm();
            return vm.PacketListVM.Sequence.Select(s => new
            {
                index       = s.Index,
                kind        = s.Kind.ToString(),
                name        = s.DisplayName,
                protocol    = s.DisplayProtocol,
                description = s.DisplayDescription,
                isChecked   = s.IsChecked
            }).ToList();
        });
        var arr = JsonNode.Parse(JsonSerializer.Serialize(items, _jsonOpts))?.AsArray() ?? new JsonArray();
        return new JsonObject { ["items"] = arr };
    }

    private async Task<JsonObject> TestCasesAddGroupAsync(JsonObject payload)
    {
        var name = payload["name"]?.GetValue<string>();
        await DispatchToUiAsync<bool>(() => { RequireMainVm().TestCaseMgrVM.AddGroupForApi(name); return true; });
        return new JsonObject { ["status"] = "group-added" };
    }

    private async Task<JsonObject> TestCasesAddAsync(JsonObject payload)
    {
        var groupIndex = payload["groupIndex"]?.GetValue<int>() ?? 0;
        var name = payload["name"]?.GetValue<string>();
        await DispatchToUiAsync<bool>(() => { RequireMainVm().TestCaseMgrVM.AddTestCaseForApi(groupIndex, name); return true; });
        return new JsonObject { ["status"] = "testcase-added" };
    }

    private async Task<JsonObject> TestCasesSelectAsync(JsonObject payload)
    {
        var groupIndex = payload["groupIndex"]?.GetValue<int>() ?? 0;
        var testCaseIndex = payload["testCaseIndex"]?.GetValue<int>() ?? 0;
        await DispatchToUiAsync<bool>(() => { RequireMainVm().TestCaseMgrVM.SelectTestCaseForApi(groupIndex, testCaseIndex); return true; });
        return new JsonObject { ["status"] = "testcase-selected" };
    }

    private async Task<JsonObject> TestCasesSaveCurrentAsync()
    {
        await DispatchToUiAsync<bool>(() => { RequireMainVm().TestCaseMgrVM.SaveCurrentToSelectedForApi(); return true; });
        return new JsonObject { ["status"] = "current-saved" };
    }

    private async Task<JsonObject> TestCasesDeleteAsync(JsonObject payload)
    {
        var groupIndex = payload["groupIndex"]?.GetValue<int>() ?? 0;
        if (payload["testCaseIndex"] is JsonNode tcNode)
        {
            var tcIdx = tcNode.GetValue<int>();
            await DispatchToUiAsync<bool>(() => { RequireMainVm().TestCaseMgrVM.DeleteTestCaseForApi(groupIndex, tcIdx); return true; });
        }
        else
        {
            await DispatchToUiAsync<bool>(() => { RequireMainVm().TestCaseMgrVM.DeleteGroupForApi(groupIndex); return true; });
        }
        return new JsonObject { ["status"] = "deleted" };
    }

    private async Task<JsonObject> SequenceRunAsync()
    {
        bool started = await DispatchToUiAsync(() => RequireMainVm().SendVM.RunSequenceForApi());
        return new JsonObject { ["status"] = started ? "started" : "already-running" };
    }

    private async Task<JsonObject> PortsLinkStatusAsync()
    {
        var regVm = await DispatchToUiAsync(() => RequireHyperTerminalVm().RegisterViewerVM);
        var statuses = await regVm.ReadAllPortLinkStatusAsync();
        var arr = new JsonArray();
        for (int i = 0; i < statuses.Length; i++)
            arr.Add(new JsonObject { ["port"] = i, ["linkUp"] = statuses[i] });
        return new JsonObject { ["ports"] = arr };
    }

    private async Task<JsonObject> SequenceAddEventAsync(JsonObject payload)
    {
        var typeName = payload["eventType"]?.GetValue<string>() ?? "Delay";
        if (!Enum.TryParse<SequenceEventType>(typeName, ignoreCase: true, out var evType))
            evType = SequenceEventType.Delay;

        var ev = new SequenceEvent
        {
            EventType        = evType,
            DelayMs          = payload["delayMs"]?.GetValue<int>()    ?? 100,
            Address          = ParseUint(payload["address"]?.GetValue<string>()  ?? "0"),
            Value            = ParseUint(payload["value"]?.GetValue<string>()    ?? "0"),
            Mask             = ParseUint(payload["mask"]?.GetValue<string>()     ?? "0xFFFFFFFF"),
            Expected         = ParseUint(payload["expected"]?.GetValue<string>() ?? "0"),
            TimeoutMs        = payload["timeoutMs"]?.GetValue<int>()  ?? 1000,
            MacAddress       = payload["macAddress"]?.GetValue<string>()  ?? "00:00:00:00:00:00",
            VlanValid        = payload["vlanValid"]?.GetValue<bool>()  ?? false,
            VlanId           = payload["vlanId"]?.GetValue<int>()      ?? 0,
            Port             = payload["port"]?.GetValue<int>()        ?? 0,
            SerialText       = payload["serialText"]?.GetValue<string>()        ?? "",
            SerialHex        = payload["serialHex"]?.GetValue<string>()         ?? "",
            CaptureInterface = payload["captureInterface"]?.GetValue<string>()  ?? "",
            CaptureFilter    = payload["captureFilter"]?.GetValue<string>()     ?? "",
            CaptureExpected  = payload["captureExpected"]?.GetValue<int>()      ?? 1
        };
        await DispatchToUiAsync<bool>(() =>
        {
            RequireMainVm().PacketListVM.AddEventForApi(ev);
            return true;
        });
        return new JsonObject { ["status"] = "event-added" };
    }

    private async Task<JsonObject> SequenceRemoveEventAsync(JsonObject payload)
    {
        var index = payload["index"]?.GetValue<int>() ?? -1;
        await DispatchToUiAsync<bool>(() =>
        {
            RequireMainVm().PacketListVM.RemoveEventForApi(index);
            return true;
        });
        return new JsonObject { ["status"] = "event-removed" };
    }

    private async Task<JsonObject> SequenceClearEventsAsync()
    {
        await DispatchToUiAsync<bool>(() =>
        {
            RequireMainVm().PacketListVM.ClearEventsForApi();
            return true;
        });
        return new JsonObject { ["status"] = "events-cleared" };
    }

    private async Task<JsonObject> SequenceGetFullAsync()
    {
        var items = await DispatchToUiAsync(() =>
        {
            var vm = RequireMainVm();
            return vm.PacketListVM.Sequence.Select(s => new
            {
                index     = s.Index,
                kind      = s.Kind.ToString(),
                name      = s.DisplayName,
                isChecked = s.IsChecked,
                eventType        = s.Event?.EventType.ToString(),
                address          = s.Event != null ? $"0x{s.Event.Address:X8}" : null,
                value            = s.Event != null ? $"0x{s.Event.Value:X8}"   : null,
                mask             = s.Event != null ? $"0x{s.Event.Mask:X8}"    : null,
                expected         = s.Event != null ? $"0x{s.Event.Expected:X8}": null,
                timeoutMs        = (int?)s.Event?.TimeoutMs,
                delayMs          = (int?)s.Event?.DelayMs,
                macAddress       = s.Event?.MacAddress,
                port             = (int?)s.Event?.Port,
                serialText       = s.Event?.SerialText,
                serialHex        = s.Event?.SerialHex,
                captureInterface = s.Event?.CaptureInterface,
                captureFilter    = s.Event?.CaptureFilter,
                label            = s.Event?.DisplayLabel ?? s.DisplayDescription
            }).ToList();
        });
        var arr = JsonNode.Parse(JsonSerializer.Serialize(items, _jsonOpts))?.AsArray() ?? new JsonArray();
        return new JsonObject { ["items"] = arr };
    }

    // =========================================================================
    // Dispatcher helper
    // =========================================================================

    private async Task<T> DispatchToUiAsync<T>(Func<T> func)
    {
        var dispatcher = _dispatcher
            ?? System.Windows.Application.Current?.Dispatcher
            ?? throw new InvalidOperationException("WPF not loaded yet");

        return await dispatcher.InvokeAsync(func);
    }

    // =========================================================================
    // ViewModel requirement helpers
    // =========================================================================

    private AutomationViewModel RequireAutomationVm()
        => AutomationVm ?? throw new InvalidOperationException("WPF not loaded yet");

    private HyperTerminalViewModel RequireHyperTerminalVm()
        => HyperTerminalVm ?? throw new InvalidOperationException("WPF not loaded yet");

    private MainViewModel RequireMainVm()
        => MainVm ?? throw new InvalidOperationException("WPF not loaded yet");

    // =========================================================================
    // Device lookup helper
    // =========================================================================

    private ILiveDevice? FindDevice(string ifaceName)
    {
        if (string.IsNullOrWhiteSpace(ifaceName))
            return CaptureDeviceList.Instance.FirstOrDefault();

        var nics = NetworkInterface.GetAllNetworkInterfaces();

        foreach (var dev in CaptureDeviceList.Instance)
        {
            // exact name match
            if (dev.Name.Equals(ifaceName, StringComparison.OrdinalIgnoreCase)) return dev;
            // description match
            if ((dev.Description ?? "").Equals(ifaceName, StringComparison.OrdinalIgnoreCase)) return dev;

            // match by OS NIC name via MAC
            var mac = dev.MacAddress?.GetAddressBytes();
            if (mac?.Length == 6)
            {
                var nic = nics.FirstOrDefault(n => n.GetPhysicalAddress().GetAddressBytes().SequenceEqual(mac));
                if (nic != null && nic.Name.Equals(ifaceName, StringComparison.OrdinalIgnoreCase)) return dev;
            }

            // contains
            if (dev.Name.Contains(ifaceName, StringComparison.OrdinalIgnoreCase)) return dev;
            if ((dev.Description ?? "").Contains(ifaceName, StringComparison.OrdinalIgnoreCase)) return dev;
        }

        return null;
    }

    // =========================================================================
    // Profile normalization: flat -> nested for LabPacketService.BuildFrame
    // =========================================================================

    private static JsonObject NormalizeProfile(JsonObject payload)
    {
        // Deep clone to avoid mutating the original
        var profile = JsonNode.Parse(payload.ToJsonString())!.AsObject();

        // Ensure ipv4 sub-object exists
        if (!profile.ContainsKey("ipv4"))
            profile["ipv4"] = new JsonObject();

        var ipv4 = profile["ipv4"]!.AsObject();

        // Lift flat srcIp / dstIp -> ipv4.src / ipv4.dst
        if (profile.ContainsKey("srcIp") && !ipv4.ContainsKey("src"))
        {
            ipv4["src"] = profile["srcIp"]!.GetValue<string>();
            profile.Remove("srcIp");
        }
        if (profile.ContainsKey("dstIp") && !ipv4.ContainsKey("dst"))
        {
            ipv4["dst"] = profile["dstIp"]!.GetValue<string>();
            profile.Remove("dstIp");
        }

        // Ensure udp sub-object for port lifting
        var protocol = (profile["protocol"]?.GetValue<string>() ?? "udp").ToLowerInvariant();
        if (protocol == "udp")
        {
            if (!profile.ContainsKey("udp"))
                profile["udp"] = new JsonObject();

            var udp = profile["udp"]!.AsObject();

            if (profile.ContainsKey("srcPort") && !udp.ContainsKey("srcPort"))
            {
                udp["srcPort"] = profile["srcPort"]!.GetValue<int>();
                profile.Remove("srcPort");
            }
            if (profile.ContainsKey("dstPort") && !udp.ContainsKey("dstPort"))
            {
                udp["dstPort"] = profile["dstPort"]!.GetValue<int>();
                profile.Remove("dstPort");
            }
        }
        else if (protocol == "tcp")
        {
            if (!profile.ContainsKey("tcp"))
                profile["tcp"] = new JsonObject();

            var tcp = profile["tcp"]!.AsObject();

            if (profile.ContainsKey("srcPort") && !tcp.ContainsKey("srcPort"))
            {
                tcp["srcPort"] = profile["srcPort"]!.GetValue<int>();
                profile.Remove("srcPort");
            }
            if (profile.ContainsKey("dstPort") && !tcp.ContainsKey("dstPort"))
            {
                tcp["dstPort"] = profile["dstPort"]!.GetValue<int>();
                profile.Remove("dstPort");
            }
        }

        return profile;
    }

    // =========================================================================
    // Utility helpers
    // =========================================================================

    private static uint ParseUint(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return 0;
        var clean = value.Trim();
        if (clean.StartsWith("0x", StringComparison.OrdinalIgnoreCase))
            return Convert.ToUInt32(clean[2..], 16);
        return uint.TryParse(clean, out var parsed) ? parsed : 0;
    }

    // =========================================================================
    // IDisposable
    // =========================================================================

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        Stop();
        _cts.Dispose();
        _wsSendLock.Dispose();
        CloseSerial();
    }
}
