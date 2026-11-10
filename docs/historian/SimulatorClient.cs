using System.Net.WebSockets;
using System.Text.Json;

namespace Historian;

/// <summary>
/// Subscribes to the simulator the way a SCADA historian subscribes to a PLC:
/// connects to its WebSocket, reads every "status" message and stores what is new.
/// Reconnects automatically if the simulator is stopped or restarted.
/// </summary>
public sealed class SimulatorClient(HistoryStore store, IConfiguration config, ILogger<SimulatorClient> log) : BackgroundService
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private static readonly TimeSpan RetryDelay = TimeSpan.FromSeconds(3);

    private string? lastState;

    public Uri Url { get; } = new(config["SimulatorUrl"] ?? "ws://localhost:3000");
    public bool Connected { get; private set; }

    protected override async Task ExecuteAsync(CancellationToken stop)
    {
        log.LogInformation("Recording to {Path}", store.DatabasePath);
        log.LogInformation("Waiting for the simulator at {Url} (start it with: npm start)", Url);

        while (!stop.IsCancellationRequested)
        {
            try
            {
                using var ws = new ClientWebSocket();
                await ws.ConnectAsync(Url, stop);
                Connected = true;
                log.LogInformation("Connected to the simulator. Recording.");
                await ReadMessages(ws, stop);
            }
            catch (OperationCanceledException) when (stop.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex) when (ex is WebSocketException or HttpRequestException or JsonException)
            {
                // Simulator not running yet, or it went away. Try again shortly.
            }

            if (Connected)
            {
                Connected = false;
                RecordState("offline");
                log.LogWarning("Lost the simulator. Retrying every {Seconds} s.", RetryDelay.TotalSeconds);
            }

            try { await Task.Delay(RetryDelay, stop); }
            catch (OperationCanceledException) { break; }
        }

        // Shutting down: mark the gap so reports don't count it as running time
        if (Connected) RecordState("offline");
    }

    private async Task ReadMessages(ClientWebSocket ws, CancellationToken stop)
    {
        var buffer = new byte[64 * 1024];
        using var message = new MemoryStream();

        while (ws.State == WebSocketState.Open)
        {
            var result = await ws.ReceiveAsync(buffer, stop);
            if (result.MessageType == WebSocketMessageType.Close) return;

            message.Write(buffer, 0, result.Count);
            if (!result.EndOfMessage) continue;

            Handle(message.GetBuffer().AsSpan(0, (int)message.Length));
            message.SetLength(0);
        }
    }

    private void Handle(ReadOnlySpan<byte> json)
    {
        // The simulator also sends 20 position frames per second for the animation.
        // The historian only needs the twice-a-second status messages.
        if (!json.StartsWith("{\"type\":\"status\""u8)) return;

        var status = JsonSerializer.Deserialize<StatusMessage>(json, Json);
        if (status is null) return;

        store.Save(status.Inspections, status.Events);
        if (status.State != lastState) RecordState(status.State);
    }

    private void RecordState(string state)
    {
        lastState = state;
        store.SaveState(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), state);
    }
}
