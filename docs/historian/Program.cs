// Robot cell historian (C# / ASP.NET Core)
// - Records everything the simulator does into a SQLite database (see SimulatorClient + HistoryStore)
// - Serves reports to the dashboard's Reports page (see ReportBuilder)
//
//   Simulator (Node, :3000) ──WebSocket──► Historian (C#, :5080) ──► data/history.db
//                                                  ▲
//                         Dashboard Reports page ──┘ HTTP: /api/report, /api/export/inspections.csv

using System.Globalization;
using System.Text;
using Historian;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddSingleton<HistoryStore>();
builder.Services.AddSingleton<SimulatorClient>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<SimulatorClient>());
builder.Services.AddSingleton<ReportBuilder>();

// The dashboard is served from another port (or opened as a file), so allow it to call this API
builder.Services.AddCors(o => o.AddDefaultPolicy(p => p.AllowAnyOrigin().AllowAnyHeader().WithMethods("GET")));

var app = builder.Build();
app.UseCors();

static int Hours(int? hours) => Math.Clamp(hours ?? 8, 1, 168);

app.MapGet("/", () => Results.Redirect("/api/health"));

app.MapGet("/api/health", (SimulatorClient simulator, HistoryStore store) =>
{
    var (first, total) = store.InspectionTotals();
    return new { simulatorConnected = simulator.Connected, simulator = simulator.Url.ToString(), database = store.DatabasePath, firstRecord = first, totalInspections = total };
});

app.MapGet("/api/report", (int? hours, ReportBuilder reports) => reports.Build(Hours(hours)));

app.MapGet("/api/export/inspections.csv", (int? hours, ReportBuilder reports) =>
{
    var csv = reports.InspectionsCsv(Hours(hours));
    var name = $"inspections-{DateTime.Now.ToString("yyyy-MM-dd-HHmm", CultureInfo.InvariantCulture)}.csv";
    return Results.File(Encoding.UTF8.GetPreamble().Concat(Encoding.UTF8.GetBytes(csv)).ToArray(), "text/csv", name);
});

app.Run();
