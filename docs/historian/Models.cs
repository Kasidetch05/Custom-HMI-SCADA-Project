namespace Historian;

// ---------- What the Node simulator sends (only the parts the historian stores) ----------

public record StatusMessage(
    string Type,
    string State,
    List<InspectionMessage> Inspections,
    List<EventMessage> Events);

public record InspectionMessage(int Id, long Time, string Size, string Result, string? Defect);

/// <summary>Alarm is the alarm id (e.g. "JAM") when the event is an alarm being raised, otherwise null.</summary>
public record EventMessage(long Time, string Level, string Text, string? Alarm);

public record StateChange(long Time, string State);

// ---------- What the historian API returns to the dashboard ----------

public record Report(
    long From,
    long To,
    bool SimulatorConnected,
    int Inspected,
    int Passed,
    int Rejected,
    double? PassRate,
    double? Availability,
    TimeBreakdown Time,
    IReadOnlyList<ReasonCount> Reasons,
    IReadOnlyList<AlarmCount> TopAlarms,
    IReadOnlyList<ProductionBucket> Production,
    int BucketMinutes,
    long? FirstRecord,
    int TotalInspections);

/// <summary>Minutes spent in each kind of state during the report window.</summary>
public record TimeBreakdown(double Running, double Stopped, double Fault, double NoData);

public record ReasonCount(string Reason, int Count);

public record AlarmCount(string Text, string Level, int Count, long LastSeen);

public record ProductionBucket(long Start, int Passed, int Rejected);
