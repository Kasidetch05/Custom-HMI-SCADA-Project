using Microsoft.Data.Sqlite;

namespace Historian;

/// <summary>
/// SQLite storage for everything the historian records: inspections, events (alarms and info)
/// and every change of the cell's state (running, stopped, faulted, ...).
/// </summary>
public sealed class HistoryStore
{
    private readonly string connectionString;
    private readonly Lock writeLock = new();

    // High-water marks so each status message only writes rows we have not seen yet
    private long lastInspectionTime;
    private long lastEventTime;

    public HistoryStore(IConfiguration config)
    {
        var path = Path.GetFullPath(config["DatabasePath"] ?? "data/history.db");
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        connectionString = new SqliteConnectionStringBuilder { DataSource = path }.ToString();
        DatabasePath = path;

        using var db = Open();
        Execute(db, """
            PRAGMA journal_mode = WAL;
            CREATE TABLE IF NOT EXISTS inspections (
                box_id  INTEGER NOT NULL,
                time    INTEGER NOT NULL,
                size    TEXT    NOT NULL,
                result  TEXT    NOT NULL,
                defect  TEXT,
                UNIQUE (box_id, time));
            CREATE TABLE IF NOT EXISTS events (
                time    INTEGER NOT NULL,
                level   TEXT    NOT NULL,
                text    TEXT    NOT NULL,
                alarm   TEXT,
                UNIQUE (time, text));
            CREATE TABLE IF NOT EXISTS states (
                time    INTEGER NOT NULL,
                state   TEXT    NOT NULL);
            CREATE INDEX IF NOT EXISTS ix_inspections_time ON inspections (time);
            CREATE INDEX IF NOT EXISTS ix_events_time ON events (time);
            CREATE INDEX IF NOT EXISTS ix_states_time ON states (time);
            """);

        lastInspectionTime = Scalar(db, "SELECT COALESCE(MAX(time), 0) FROM inspections");
        lastEventTime = Scalar(db, "SELECT COALESCE(MAX(time), 0) FROM events");
    }

    public string DatabasePath { get; }

    // ---------- Writing ----------

    public void Save(IEnumerable<InspectionMessage> inspections, IEnumerable<EventMessage> events)
    {
        var newInspections = inspections.Where(i => i.Time >= lastInspectionTime).ToList();
        var newEvents = events.Where(e => e.Time >= lastEventTime).ToList();
        if (newInspections.Count == 0 && newEvents.Count == 0) return;

        lock (writeLock)
        {
            using var db = Open();
            using var tx = db.BeginTransaction();

            using var insertInspection = Command(db, "INSERT OR IGNORE INTO inspections VALUES ($id, $time, $size, $result, $defect)");
            insertInspection.Transaction = tx;
            foreach (var i in newInspections)
            {
                SetParameters(insertInspection, ("$id", i.Id), ("$time", i.Time), ("$size", i.Size), ("$result", i.Result), ("$defect", i.Defect));
                insertInspection.ExecuteNonQuery();
                lastInspectionTime = Math.Max(lastInspectionTime, i.Time);
            }

            using var insertEvent = Command(db, "INSERT OR IGNORE INTO events VALUES ($time, $level, $text, $alarm)");
            insertEvent.Transaction = tx;
            foreach (var e in newEvents)
            {
                SetParameters(insertEvent, ("$time", e.Time), ("$level", e.Level), ("$text", e.Text), ("$alarm", e.Alarm));
                insertEvent.ExecuteNonQuery();
                lastEventTime = Math.Max(lastEventTime, e.Time);
            }

            tx.Commit();
        }
    }

    public void SaveState(long time, string state)
    {
        lock (writeLock)
        {
            using var db = Open();
            Execute(db, "INSERT INTO states VALUES ($time, $state)", ("$time", time), ("$state", state));
        }
    }

    // ---------- Reading ----------

    public List<InspectionRow> Inspections(long from, long to)
    {
        using var db = Open();
        using var cmd = Command(db, "SELECT box_id, time, size, result, defect FROM inspections WHERE time BETWEEN $from AND $to ORDER BY time",
            ("$from", from), ("$to", to));
        using var r = cmd.ExecuteReader();
        var rows = new List<InspectionRow>();
        while (r.Read())
            rows.Add(new InspectionRow(r.GetInt32(0), r.GetInt64(1), r.GetString(2), r.GetString(3), r.IsDBNull(4) ? null : r.GetString(4)));
        return rows;
    }

    /// <summary>Alarms raised in the window, most frequent first.</summary>
    public List<AlarmCount> TopAlarms(long from, long to, int limit)
    {
        using var db = Open();
        using var cmd = Command(db, """
            SELECT text, level, COUNT(*) AS n, MAX(time)
            FROM events
            WHERE alarm IS NOT NULL AND time BETWEEN $from AND $to
            GROUP BY text, level
            ORDER BY n DESC, MAX(time) DESC
            LIMIT $limit
            """, ("$from", from), ("$to", to), ("$limit", limit));
        using var r = cmd.ExecuteReader();
        var rows = new List<AlarmCount>();
        while (r.Read()) rows.Add(new AlarmCount(r.GetString(0), r.GetString(1), r.GetInt32(2), r.GetInt64(3)));
        return rows;
    }

    /// <summary>State changes in the window, plus the last one before it (the state the window starts in).</summary>
    public List<StateChange> States(long from, long to)
    {
        using var db = Open();
        using var cmd = Command(db, """
            SELECT time, state FROM (SELECT time, state FROM states WHERE time < $from ORDER BY time DESC LIMIT 1)
            UNION ALL
            SELECT time, state FROM states WHERE time BETWEEN $from AND $to
            ORDER BY time
            """, ("$from", from), ("$to", to));
        using var r = cmd.ExecuteReader();
        var rows = new List<StateChange>();
        while (r.Read()) rows.Add(new StateChange(r.GetInt64(0), r.GetString(1)));
        return rows;
    }

    public (long? First, int Total) InspectionTotals()
    {
        using var db = Open();
        using var cmd = Command(db, "SELECT MIN(time), COUNT(*) FROM inspections");
        using var r = cmd.ExecuteReader();
        r.Read();
        return (r.IsDBNull(0) ? null : r.GetInt64(0), r.GetInt32(1));
    }

    // ---------- SQLite helpers ----------

    private SqliteConnection Open()
    {
        var db = new SqliteConnection(connectionString);
        db.Open();
        return db;
    }

    private static SqliteCommand Command(SqliteConnection db, string sql, params (string Name, object? Value)[] args)
    {
        var cmd = db.CreateCommand();
        cmd.CommandText = sql;
        SetParameters(cmd, args);
        return cmd;
    }

    private static void SetParameters(SqliteCommand cmd, params (string Name, object? Value)[] args)
    {
        cmd.Parameters.Clear();
        foreach (var (name, value) in args) cmd.Parameters.AddWithValue(name, value ?? DBNull.Value);
    }

    private static void Execute(SqliteConnection db, string sql, params (string Name, object? Value)[] args)
    {
        using var cmd = Command(db, sql, args);
        cmd.ExecuteNonQuery();
    }

    private static long Scalar(SqliteConnection db, string sql)
    {
        using var cmd = Command(db, sql);
        return Convert.ToInt64(cmd.ExecuteScalar());
    }
}

public record InspectionRow(int BoxId, long Time, string Size, string Result, string? Defect);
