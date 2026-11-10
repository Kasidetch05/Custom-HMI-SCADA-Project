using System.Globalization;
using System.Text;

namespace Historian;

/// <summary>Turns the recorded history into the numbers a shift supervisor wants to see.</summary>
public sealed class ReportBuilder(HistoryStore store, SimulatorClient simulator)
{
    public Report Build(int hours)
    {
        var to = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var from = to - hours * 3_600_000L;

        var inspections = store.Inspections(from, to);
        var passed = inspections.Count(i => i.Result == "pass");
        var rejected = inspections.Count - passed;

        var reasons = inspections
            .Where(i => i.Result == "fail" && i.Defect is not null)
            .GroupBy(i => i.Defect!)
            .Select(g => new ReasonCount(g.Key, g.Count()))
            .OrderByDescending(r => r.Count)
            .ToList();

        var time = TimeInEachState(store.States(from, to), from, to);
        var worked = time.Running + time.Fault;
        var (first, total) = store.InspectionTotals();
        var bucketMinutes = hours <= 1 ? 5 : hours <= 8 ? 30 : 60;

        return new Report(
            From: from,
            To: to,
            SimulatorConnected: simulator.Connected,
            Inspected: inspections.Count,
            Passed: passed,
            Rejected: rejected,
            PassRate: inspections.Count > 0 ? (double)passed / inspections.Count : null,
            Availability: worked > 0 ? time.Running / worked : null,
            Time: time,
            Reasons: reasons,
            TopAlarms: store.TopAlarms(from, to, limit: 6),
            Production: Buckets(inspections, from, to, bucketMinutes),
            BucketMinutes: bucketMinutes,
            FirstRecord: first,
            TotalInspections: total);
    }

    /// <summary>
    /// Walks through the state changes and adds up how long the cell spent in each kind of state.
    /// Time before the first recorded state counts as "no data" (historian or simulator not running).
    /// </summary>
    public static TimeBreakdown TimeInEachState(IReadOnlyList<StateChange> changes, long from, long to)
    {
        double running = 0, stopped = 0, fault = 0, noData = 0;

        var firstStart = changes.Count > 0 ? Math.Max(changes[0].Time, from) : to;
        noData += firstStart - from;

        for (var i = 0; i < changes.Count; i++)
        {
            var start = Math.Max(changes[i].Time, from);
            var end = i + 1 < changes.Count ? changes[i + 1].Time : to;
            if (end <= start) continue;
            var ms = end - start;

            switch (changes[i].State)
            {
                case "running" or "stopping": running += ms; break;
                case "faulted" or "estop": fault += ms; break;
                case "stopped": stopped += ms; break;
                default: noData += ms; break; // "offline"
            }
        }

        static double Minutes(double ms) => Math.Round(ms / 60_000, 1);
        return new TimeBreakdown(Minutes(running), Minutes(stopped), Minutes(fault), Minutes(noData));
    }

    private static List<ProductionBucket> Buckets(List<InspectionRow> rows, long from, long to, int minutes)
    {
        var size = minutes * 60_000L;
        var start = from / size * size;
        var buckets = new List<ProductionBucket>();
        for (var t = start; t < to; t += size)
        {
            var inBucket = rows.Where(r => r.Time >= t && r.Time < t + size).ToList();
            buckets.Add(new ProductionBucket(t, inBucket.Count(r => r.Result == "pass"), inBucket.Count(r => r.Result == "fail")));
        }
        return buckets;
    }

    public string InspectionsCsv(int hours)
    {
        var to = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var rows = store.Inspections(to - hours * 3_600_000L, to);
        var sizes = new Dictionary<string, string> { ["S"] = "Small", ["M"] = "Medium", ["L"] = "Large" };

        var csv = new StringBuilder("Box,Inspected at,Size,Result,Defect\r\n");
        foreach (var r in rows)
        {
            var when = DateTimeOffset.FromUnixTimeMilliseconds(r.Time).ToLocalTime().ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture);
            var result = r.Result == "pass" ? "Passed" : "Rejected";
            csv.Append(CultureInfo.InvariantCulture, $"{r.BoxId},{when},{sizes.GetValueOrDefault(r.Size, r.Size)},{result},{r.Defect ?? ""}\r\n");
        }
        return csv.ToString();
    }
}
