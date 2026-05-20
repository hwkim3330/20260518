using System.Collections.ObjectModel;
using System.IO.Ports;
using System.Windows.Input;
using EthernetPacketGenerator.Commands;
using EthernetPacketGenerator.Services;

namespace EthernetPacketGenerator.ViewModels;

public class HyperTerminalViewModel : ViewModelBase
{
    private readonly SerialPortService _serial;

    public RegisterViewerViewModel RegisterViewerVM { get; }

    // 포트 없음 플레이스홀더 — 실제 COM 포트와 구별하기 위해 PortName을 null로 설정
    private static readonly PortInfo NoPortItem = new(string.Empty, "(연결된 포트 없음)");

    // ── 포트 설정 ─────────────────────────────────────────────────────────────
    private PortInfo? _selectedPortInfo;
    private int      _selectedBaudRate = 115200;
    private bool     _isConnected;
    private string   _connectionStatus = "연결 안 됨";

    public ObservableCollection<PortInfo> PortInfos { get; } = new();
    public IReadOnlyList<int>             BaudRates { get; } = new[] { 9600, 19200, 38400, 57600, 115200, 230400, 921600 };

    public PortInfo? SelectedPortInfo
    {
        get => _selectedPortInfo;
        set => SetProperty(ref _selectedPortInfo, value);
    }

    public int SelectedBaudRate
    {
        get => _selectedBaudRate;
        set => SetProperty(ref _selectedBaudRate, value);
    }

    public bool IsConnected
    {
        get => _isConnected;
        set
        {
            SetProperty(ref _isConnected, value);
            OnPropertyChanged(nameof(ConnectLabel));
            System.Windows.Application.Current?.Dispatcher.InvokeAsync(
                System.Windows.Input.CommandManager.InvalidateRequerySuggested,
                System.Windows.Threading.DispatcherPriority.Background);
        }
    }

    public string ConnectionStatus
    {
        get => _connectionStatus;
        set => SetProperty(ref _connectionStatus, value);
    }

    public string ConnectLabel => IsConnected ? "연결 해제" : "연결";

    // ── 터미널 출력 ───────────────────────────────────────────────────────────
    private string _terminalOutput = string.Empty;
    private string _inputText      = string.Empty;

    public string TerminalOutput
    {
        get => _terminalOutput;
        set => SetProperty(ref _terminalOutput, value);
    }

    public string InputText
    {
        get => _inputText;
        set => SetProperty(ref _inputText, value);
    }

    // ── Commands ──────────────────────────────────────────────────────────────
    public ICommand RefreshPortsCommand  { get; }
    public ICommand ConnectCommand       { get; }
    public ICommand SendLineCommand      { get; }
    public ICommand ClearTerminalCommand { get; }

    public HyperTerminalViewModel(SerialPortService serial)
    {
        _serial = serial;
        RegisterViewerVM = new RegisterViewerViewModel(_serial);
        _serial.LineReceived   += OnLineReceived;
        _serial.ErrorOccurred  += OnError;
        _serial.PortListChanged += RefreshPorts;   // USB 연결/해제 시 자동 갱신
        _serial.StartDeviceWatcher();

        RefreshPortsCommand  = new RelayCommand(RefreshPorts);
        ConnectCommand       = new RelayCommand(ToggleConnect,
            () => SelectedPortInfo != null && SelectedPortInfo != NoPortItem);
        SendLineCommand      = new RelayCommand(SendLine,
            () => IsConnected && !string.IsNullOrEmpty(InputText));
        ClearTerminalCommand = new RelayCommand(() => TerminalOutput = string.Empty);

        RefreshPorts();
    }

    // ── 포트 목록 갱신 ────────────────────────────────────────────────────────
    private void RefreshPorts()
    {
        var currentPort = (SelectedPortInfo == NoPortItem) ? null : SelectedPortInfo?.PortName;
        PortInfos.Clear();

        var infos = SerialPortService.GetPortInfos().ToList();
        if (infos.Count == 0)
        {
            PortInfos.Add(NoPortItem);
            SelectedPortInfo = NoPortItem;
            return;
        }

        foreach (var info in infos)
            PortInfos.Add(info);

        // 이전에 선택했던 포트가 아직 연결되어 있으면 유지, 아니면 첫 번째 선택
        SelectedPortInfo = PortInfos.FirstOrDefault(p => p.PortName == currentPort)
                        ?? PortInfos.First();
    }

    // ── 연결 / 해제 토글 ──────────────────────────────────────────────────────
    private void ToggleConnect()
    {
        if (IsConnected)
        {
            _serial.Close();
            IsConnected = false;
            ConnectionStatus = "연결 안 됨";
            AppendTerminal("[연결 해제]");
            return;
        }

        if (SelectedPortInfo == null || SelectedPortInfo == NoPortItem) return;

        try
        {
            _serial.Open(SelectedPortInfo.PortName, SelectedBaudRate,
                         Parity.None, 8, StopBits.One);
            IsConnected = true;
            ConnectionStatus = $"{SelectedPortInfo.PortName}  {SelectedBaudRate}bps";
            AppendTerminal($"[{SelectedPortInfo.DisplayName} 연결됨 — {SelectedBaudRate}bps]");
        }
        catch (Exception ex)
        {
            ConnectionStatus = $"오류: {ex.Message}";
            AppendTerminal($"[연결 실패: {ex.Message}]");
        }
    }

    // ── 커맨드 전송 ───────────────────────────────────────────────────────────
    private void SendLine()
    {
        if (string.IsNullOrEmpty(InputText)) return;

        try
        {
            AppendTerminal($"> {InputText}");
            _serial.SendLine(InputText);
            InputText = string.Empty;
        }
        catch (Exception ex)
        {
            AppendTerminal($"[전송 실패: {ex.Message}]");
        }
    }

    // ── 수신 처리 ─────────────────────────────────────────────────────────────
    private void OnLineReceived(string line) => AppendTerminal(line);

    private void OnError(string message) => AppendTerminal($"[오류: {message}]");

    public void AppendTerminal(string line)
    {
        var timestamp = DateTime.Now.ToString("HH:mm:ss.fff");
        TerminalOutput += $"[{timestamp}]  {line}\n";
    }

    public void RefreshPortsForApi() => RefreshPorts();

    public void ConnectForApi(string portName, int baudRate)
    {
        RefreshPorts();
        SelectedPortInfo = PortInfos.FirstOrDefault(p =>
            p.PortName.Equals(portName, StringComparison.OrdinalIgnoreCase));
        SelectedBaudRate = baudRate;

        if (SelectedPortInfo == null || SelectedPortInfo == NoPortItem)
            throw new InvalidOperationException($"Port not found: {portName}");

        if (IsConnected)
            _serial.Close();

        _serial.Open(SelectedPortInfo.PortName, SelectedBaudRate, Parity.None, 8, StopBits.One);
        IsConnected = true;
        ConnectionStatus = $"{SelectedPortInfo.PortName}  {SelectedBaudRate}bps";
        AppendTerminal($"[connected: {SelectedPortInfo.DisplayName} @ {SelectedBaudRate}bps]");
    }

    public void DisconnectForApi()
    {
        _serial.Close();
        IsConnected = false;
        ConnectionStatus = "Disconnected";
        AppendTerminal("[disconnected]");
    }

    public void SendForApi(string text)
    {
        if (string.IsNullOrWhiteSpace(text)) return;
        AppendTerminal($"> {text}");
        _serial.SendLine(text);
    }

    public void SendBytesForApi(byte[] data)
    {
        if (data.Length == 0) return;
        AppendTerminal($"> hex {Convert.ToHexString(data).ToLowerInvariant()}");
        _serial.SendBytes(data);
    }

    public void ControlForApi(string cmd, bool? rts = null, bool? dtr = null)
    {
        if (cmd.Equals("break", StringComparison.OrdinalIgnoreCase))
        {
            _serial.SendBreak();
            AppendTerminal("[break]");
            return;
        }

        _serial.SetSignals(rts, dtr);
        AppendTerminal($"[signals rts={rts?.ToString() ?? "-"} dtr={dtr?.ToString() ?? "-"}]");
    }

    public void ClearForApi() => TerminalOutput = string.Empty;

    public object GetSnapshot()
    {
        RefreshPorts();
        return new
        {
            ports = PortInfos.Select(p => new { p.PortName, p.DisplayName }).ToList(),
            baudRates = BaudRates.ToList(),
            selectedPort = SelectedPortInfo?.PortName ?? string.Empty,
            selectedBaudRate = SelectedBaudRate,
            isConnected = IsConnected,
            connectionStatus = ConnectionStatus,
            terminalOutput = TerminalOutput
        };
    }
}
