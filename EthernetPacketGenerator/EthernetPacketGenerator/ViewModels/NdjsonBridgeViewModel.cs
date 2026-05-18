using System.Collections.ObjectModel;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Windows.Input;
using System.Windows.Threading;
using EthernetPacketGenerator.Commands;
using EthernetPacketGenerator.Models;

namespace EthernetPacketGenerator.ViewModels;

/// <summary>
/// Represents a single interface item returned by the peer probe.
/// </summary>
public sealed class RemoteInterfaceItem : ViewModelBase
{
    private bool _isSelected;

    public string Key         { get; init; } = "";
    public string Name        { get; init; } = "";
    public string Mac         { get; init; } = "";
    public string State       { get; init; } = "";
    public string Description { get; init; } = "";

    public bool IsSelected
    {
        get => _isSelected;
        set => SetProperty(ref _isSelected, value);
    }

    public string DisplayName => string.IsNullOrWhiteSpace(Description)
        ? Name
        : $"{Name}  —  {Description}";
}

/// <summary>
/// Remote-capture row shown in the DataGrid.
/// Populated from peer's /api/capture/packets response.
/// Inherits ViewModelBase so IsMatch can trigger DataTrigger row highlight.
/// </summary>
public sealed class RemoteCaptureRow : ViewModelBase
{
    private bool _isMatch;

    public int    No            { get; init; }
    public string Time          { get; init; } = "";
    public string InterfaceName { get; init; } = "";
    public string SrcMac        { get; init; } = "";
    public string DstMac        { get; init; } = "";
    public string Source        { get; init; } = "";
    public string Destination   { get; init; } = "";
    public string Protocol      { get; init; } = "";
    public int    Length        { get; init; }
    public string Info          { get; init; } = "";
    public string DetailJson    { get; init; } = "";
    public string HexDump       { get; init; } = "";  // formatted hex from peer frameHex

    /// <summary>True when this row matches the evaluated target address — drives DataTrigger highlight.</summary>
    public bool IsMatch
    {
        get => _isMatch;
        set => SetProperty(ref _isMatch, value);
    }
}

/// <summary>
/// ViewModel for the "Capture Address" tab.
/// Probes a remote peer's interfaces, starts/stops capture there,
/// polls packets directly from the peer (no Node.js proxy hop needed from C#),
/// and evaluates PASS/FAIL.
/// </summary>
public sealed class NdjsonBridgeViewModel : ViewModelBase, IDisposable
{
    // ── HTTP client (shared, long-lived) ──────────────────────────────────────
    // C# has no CORS restrictions → call the peer directly, no proxy needed.
    private static readonly HttpClient _http = new HttpClient
    {
        Timeout = TimeSpan.FromSeconds(10)
    };

    // ── State ─────────────────────────────────────────────────────────────────
    private string            _peerUrl        = "http://localhost:8080";
    private string            _status         = "Enter peer URL and press Probe.";
    private string            _targetAddress  = "";
    private string            _resultText     = "";
    private bool              _isCapturing    = false;
    private int               _lastOffset     = 0;
    private RemoteCaptureRow? _selectedPacket = null;

    private DispatcherTimer? _pollTimer;

    // ── Peer base URL helper ──────────────────────────────────────────────────
    private string PeerBase => _peerUrl.TrimEnd('/');

    // ── Public bindable properties ────────────────────────────────────────────
    public string PeerUrl
    {
        get => _peerUrl;
        set => SetProperty(ref _peerUrl, value);
    }

    public string Status
    {
        get => _status;
        private set => SetProperty(ref _status, value);
    }

    public string TargetAddress
    {
        get => _targetAddress;
        set => SetProperty(ref _targetAddress, value);
    }

    public string ResultText
    {
        get => _resultText;
        private set => SetProperty(ref _resultText, value);
    }

    public bool IsCapturing
    {
        get => _isCapturing;
        private set
        {
            SetProperty(ref _isCapturing, value);
            System.Windows.Application.Current?.Dispatcher.InvokeAsync(
                System.Windows.Input.CommandManager.InvalidateRequerySuggested,
                DispatcherPriority.Background);
        }
    }

    public RemoteCaptureRow? SelectedPacket
    {
        get => _selectedPacket;
        set
        {
            if (SetProperty(ref _selectedPacket, value))
                OnPropertyChanged(nameof(SelectedDetailText));
        }
    }

    public string SelectedDetailText
    {
        get
        {
            if (_selectedPacket == null)
                return "Select a packet row to inspect decoded fields.";
            var parts = new List<string>();
            if (!string.IsNullOrWhiteSpace(_selectedPacket.DetailJson))
                parts.Add(_selectedPacket.DetailJson);
            if (!string.IsNullOrWhiteSpace(_selectedPacket.HexDump))
                parts.Add("\n--- HEX DUMP ---\n" + _selectedPacket.HexDump);
            return parts.Count > 0 ? string.Join("\n", parts) : "(no decoded data)";
        }
    }

    // ── Collections ───────────────────────────────────────────────────────────
    public ObservableCollection<RemoteInterfaceItem> PeerInterfaces { get; } = new();
    public ObservableCollection<RemoteCaptureRow>    Packets        { get; } = new();

    // ── Commands ──────────────────────────────────────────────────────────────
    public ICommand ProbeCommand   { get; }
    public ICommand StartCommand   { get; }
    public ICommand StopCommand    { get; }
    public ICommand ClearCommand   { get; }
    public ICommand CheckCommand   { get; }

    // ── Constructor ───────────────────────────────────────────────────────────
    public NdjsonBridgeViewModel()
    {
        ProbeCommand = new RelayCommand(
            async () => await ProbeAsync(),
            () => !IsCapturing);

        StartCommand = new RelayCommand(
            async () => await StartCaptureAsync(),
            () => !IsCapturing && PeerInterfaces.Any(i => i.IsSelected));

        StopCommand = new RelayCommand(
            async () => await StopCaptureAsync(),
            () => IsCapturing);

        ClearCommand = new RelayCommand(
            async () => await ClearAsync());

        CheckCommand = new RelayCommand(Evaluate);
    }

    // ── Probe — direct peer call (no proxy hop) ───────────────────────────────
    private async Task ProbeAsync()
    {
        Status = "Probing peer…";
        PeerInterfaces.Clear();

        try
        {
            // C# has no CORS — call peer directly.
            var resp = await _http.GetAsync($"{PeerBase}/api/interfaces");
            if (!resp.IsSuccessStatusCode)
            {
                Status = $"Probe failed: HTTP {(int)resp.StatusCode}";
                return;
            }
            var json = await resp.Content.ReadAsStringAsync();
            var doc  = JsonDocument.Parse(json);
            var root = doc.RootElement;

            var ifaceProp = root.TryGetProperty("interfaces", out var ip) ? ip : default;
            if (ifaceProp.ValueKind == JsonValueKind.Array)
            {
                foreach (var iface in ifaceProp.EnumerateArray())
                {
                    string GetStr(JsonElement el, params string[] keys)
                    {
                        foreach (var key in keys)
                            if (el.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.String)
                                return v.GetString() ?? "";
                        return "";
                    }
                    PeerInterfaces.Add(new RemoteInterfaceItem
                    {
                        Key         = GetStr(iface, "key", "name", "deviceName"),
                        Name        = GetStr(iface, "name", "deviceName", "key"),
                        Mac         = GetStr(iface, "mac"),
                        State       = GetStr(iface, "state"),
                        Description = GetStr(iface, "description"),
                        IsSelected  = false
                    });
                }
                // Auto-select first
                if (PeerInterfaces.Count > 0)
                    PeerInterfaces[0].IsSelected = true;
            }

            Status = $"Probe OK — {PeerInterfaces.Count} NIC(s) found on {PeerUrl}";
            System.Windows.Input.CommandManager.InvalidateRequerySuggested();
        }
        catch (Exception ex)
        {
            Status = $"Probe error: {ex.Message}";
        }
    }

    // ── Start capture — clear first, then start directly on peer ─────────────
    private async Task StartCaptureAsync()
    {
        var selected = PeerInterfaces.Where(i => i.IsSelected).Select(i => i.Key).ToArray();
        if (selected.Length == 0)
        {
            Status = "Select at least one interface.";
            return;
        }

        // Reset local state
        Packets.Clear();
        _lastOffset   = 0;
        ResultText    = "";
        TargetAddress = "";

        try
        {
            // Clear first (best-effort)
            try
            {
                await _http.PostAsync($"{PeerBase}/api/capture/clear",
                    new StringContent("{}", Encoding.UTF8, "application/json"));
            }
            catch { /* ignore */ }

            // Start capture directly on peer
            var body    = JsonSerializer.Serialize(new { interfaces = selected });
            var content = new StringContent(body, Encoding.UTF8, "application/json");
            var resp    = await _http.PostAsync($"{PeerBase}/api/capture/start", content);
            if (!resp.IsSuccessStatusCode)
            {
                Status = $"Start failed: HTTP {(int)resp.StatusCode}";
                return;
            }

            IsCapturing = true;
            Status = $"Capturing from {PeerUrl} on [{string.Join(", ", selected)}]…";

            // Poll every 500 ms
            _pollTimer = new DispatcherTimer(DispatcherPriority.Background)
            {
                Interval = TimeSpan.FromMilliseconds(500)
            };
            _pollTimer.Tick += async (_, _) => await PollAsync();
            _pollTimer.Start();
        }
        catch (Exception ex)
        {
            Status = $"Start error: {ex.Message}";
        }
    }

    // ── Stop capture — direct peer call ──────────────────────────────────────
    private async Task StopCaptureAsync()
    {
        _pollTimer?.Stop();
        _pollTimer = null;
        IsCapturing = false;

        try
        {
            await _http.PostAsync($"{PeerBase}/api/capture/stop",
                new StringContent("{}", Encoding.UTF8, "application/json"));
        }
        catch { /* ignore */ }

        // One final poll
        await PollAsync();
        Status = $"Stopped. {Packets.Count} packet(s) captured.";
    }

    // ── Clear — direct peer call ──────────────────────────────────────────────
    private async Task ClearAsync()
    {
        if (IsCapturing) await StopCaptureAsync();

        Packets.Clear();
        _lastOffset   = 0;
        ResultText    = "";
        TargetAddress = "";

        try
        {
            await _http.PostAsync($"{PeerBase}/api/capture/clear",
                new StringContent("{}", Encoding.UTF8, "application/json"));
        }
        catch { /* ignore */ }

        Status = "Cleared.";
    }

    // ── Poll for new packets — direct peer call ───────────────────────────────
    // Uses offset parameter so the peer returns only new rows since last poll.
    private async Task PollAsync()
    {
        try
        {
            var url  = $"{PeerBase}/api/capture/packets?limit=500&offset={_lastOffset}";
            var resp = await _http.GetAsync(url);
            if (!resp.IsSuccessStatusCode) return;
            var json = await resp.Content.ReadAsStringAsync();
            var doc  = JsonDocument.Parse(json);
            var root = doc.RootElement;

            // Accept both "rows" and "packets" key names
            JsonElement rowsProp;
            if (!root.TryGetProperty("rows", out rowsProp) &&
                !root.TryGetProperty("packets", out rowsProp)) return;

            var newRows = rowsProp.EnumerateArray().ToList();
            if (newRows.Count == 0) return;

            _lastOffset += newRows.Count;

            foreach (var row in newRows)
            {
                var pkt = ParseRow(Packets.Count + 1, row);
                Packets.Add(pkt);
            }
        }
        catch { /* silently ignore polling errors */ }
    }

    // ── Parse a packet JSON element into RemoteCaptureRow ────────────────────
    private static RemoteCaptureRow ParseRow(int no, JsonElement row)
    {
        var decoded = row.TryGetProperty("decoded", out var dec) ? dec : default;
        var eth     = decoded.ValueKind != JsonValueKind.Undefined && decoded.TryGetProperty("ethernet", out var e) ? e
                    : decoded.ValueKind != JsonValueKind.Undefined && decoded.TryGetProperty("eth",      out var e2) ? e2
                    : default;

        string Get(JsonElement el, string prop) =>
            el.ValueKind != JsonValueKind.Undefined && el.TryGetProperty(prop, out var v) ? v.GetString() ?? "" : "";

        var srcMac = Get(eth, "srcMac") is { Length: > 0 } sm ? sm : Get(eth, "src");
        var dstMac = Get(eth, "dstMac") is { Length: > 0 } dm ? dm : Get(eth, "dst");

        JsonElement ipv4 = default, arp = default, ipv6 = default;
        if (decoded.ValueKind != JsonValueKind.Undefined)
        {
            decoded.TryGetProperty("ipv4",  out ipv4);
            decoded.TryGetProperty("arp",   out arp);
            decoded.TryGetProperty("ipv6",  out ipv6);
        }

        var srcIp = Get(ipv4, "src") is { Length: > 0 } si ? si
                  : Get(arp,  "senderIp") is { Length: > 0 } ai ? ai
                  : Get(ipv6, "src");

        var dstIp = Get(ipv4, "dst") is { Length: > 0 } di ? di
                  : Get(arp,  "targetIp") is { Length: > 0 } ati ? ati
                  : Get(ipv6, "dst");

        // Timestamp
        double ts = row.TryGetProperty("timestamp", out var tsProp) ? tsProp.GetDouble() : 0;
        var dt = DateTimeOffset.FromUnixTimeMilliseconds((long)(ts * 1000));
        var tStr = dt.ToLocalTime().ToString("HH:mm:ss.fff");

        // Protocol
        var proto = "ETH";
        if (decoded.ValueKind != JsonValueKind.Undefined)
        {
            if (decoded.TryGetProperty("udp",    out _)) proto = "UDP";
            else if (decoded.TryGetProperty("tcp",  out _)) proto = "TCP";
            else if (decoded.TryGetProperty("icmp", out _)) proto = "ICMP";
            else if (decoded.TryGetProperty("arp",  out _)) proto = "ARP";
            else if (decoded.TryGetProperty("ipv6", out _)) proto = "IPv6";
            else if (decoded.TryGetProperty("ipv4", out _)) proto = "IPv4";
        }

        var iface   = row.TryGetProperty("interface", out var ifProp) ? ifProp.GetString() ?? "" : "";
        var length  = row.TryGetProperty("length",    out var lenProp) ? lenProp.GetInt32() : 0;
        var detail  = decoded.ValueKind != JsonValueKind.Undefined
            ? JsonSerializer.Serialize(decoded, new JsonSerializerOptions { WriteIndented = true })
            : "";

        // Build a formatted hex dump from the peer's raw frameHex string
        var hexDump = "";
        if (row.TryGetProperty("frameHex", out var fhProp) && fhProp.ValueKind == JsonValueKind.String)
        {
            var raw = fhProp.GetString() ?? "";
            // Strip spaces, then group into lines of 32 chars (16 bytes)
            var clean = raw.Replace(" ", "").Replace("\n", "");
            var sb    = new System.Text.StringBuilder();
            for (int offset = 0; offset < clean.Length; offset += 32)
            {
                var chunk = clean.Substring(offset, Math.Min(32, clean.Length - offset));
                var hex   = string.Join(" ", Enumerable.Range(0, chunk.Length / 2)
                    .Select(i => chunk.Substring(i * 2, 2)));
                sb.AppendLine($"{offset / 2:X4}  {hex}");
            }
            hexDump = sb.ToString();
        }

        return new RemoteCaptureRow
        {
            No            = no,
            Time          = tStr,
            InterfaceName = iface,
            SrcMac        = srcMac,
            DstMac        = dstMac,
            Source        = srcIp,
            Destination   = dstIp,
            Protocol      = proto,
            Length        = length,
            Info          = $"{srcMac} → {dstMac}",
            DetailJson    = detail,
            HexDump       = hexDump
        };
    }

    // ── PASS/FAIL evaluation ──────────────────────────────────────────────────
    private void Evaluate()
    {
        var addr = (TargetAddress ?? "").Trim().ToLowerInvariant();
        if (string.IsNullOrEmpty(addr))
        {
            ResultText = "";
            // Clear IsMatch flags — each row raises PropertyChanged via SetProperty
            foreach (var p in Packets) p.IsMatch = false;
            return;
        }

        var total   = Packets.Count;
        var matches = Packets.Where(p => RowMatchesAddr(p, addr)).ToList();
        var verdict = matches.Count > 0 ? "PASS" : "FAIL";

        // Mark matching rows — SetProperty raises PropertyChanged → DataTrigger highlights
        foreach (var p in Packets)
            p.IsMatch = matches.Contains(p);

        ResultText = $"{verdict}  —  Target: {addr}  |  Matched: {matches.Count}/{total} packet(s)";
        Status     = $"{verdict}: {matches.Count}/{total} packet(s) matched address '{addr}'.";
    }

    private static bool RowMatchesAddr(RemoteCaptureRow row, string addr)
    {
        // IP match
        if (System.Text.RegularExpressions.Regex.IsMatch(addr, @"^\d{1,3}\.\d{1,3}"))
        {
            return row.Source.Contains(addr, StringComparison.OrdinalIgnoreCase) ||
                   row.Destination.Contains(addr, StringComparison.OrdinalIgnoreCase);
        }
        // MAC match (substring)
        var normAddr = addr.Replace("-", ":").Replace(" ", "");
        var normSrc  = row.SrcMac.ToLowerInvariant().Replace("-", ":");
        var normDst  = row.DstMac.ToLowerInvariant().Replace("-", ":");
        return normSrc.Contains(normAddr) || normDst.Contains(normAddr);
    }

    // ── IDisposable ───────────────────────────────────────────────────────────
    public void Dispose()
    {
        _pollTimer?.Stop();
        _pollTimer = null;
    }
}
