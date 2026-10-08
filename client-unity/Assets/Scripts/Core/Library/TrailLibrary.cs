using System;
using System.Collections.Generic;
using System.Linq;

namespace ArQuestTrail.Core
{
    public static class LibraryStatus
    {
        public const string NotStarted = "not_started";
        public const string Active = "active";
        public const string Completed = "completed";
        public const string Expired = "expired";
    }

    /// <summary>One trail on the "My trails" screen.</summary>
    public sealed class LibraryEntry
    {
        public string TrailId { get; set; }
        public string Name { get; set; }

        /// <summary>Formatted, e.g. "ABCD-EFGH"; null for a trail opened by id (the Editor shortcut).</summary>
        public string JoinCode { get; set; }

        public int PinCount { get; set; }

        /// <summary>GDR-08: null means no time limit.</summary>
        public int? ExpiryDays { get; set; }

        /// <summary>One of <see cref="LibraryStatus"/>, as of the last time this device saw the attempt.</summary>
        public string Status { get; set; } = LibraryStatus.NotStarted;

        public int PinsCompleted { get; set; }

        public string AddedAt { get; set; }

        public string LastPlayedAt { get; set; }
    }

    /// <summary>
    /// The trails this player has joined, kept on the device. There is deliberately no server-side
    /// "my trails" listing: SR-DATA-02 keeps every query scoped to one player and there is no trail
    /// browsing at all, so the device remembers what it joined. It lives in the same store as the
    /// rest of the player's local data, so SR-PRIV-02's delete clears it with everything else.
    /// </summary>
    public sealed class TrailLibrary
    {
        private const string StorageKey = "trail_library";

        private readonly IKeyValueStore _store;
        private readonly IClock _clock;

        public TrailLibrary(IKeyValueStore store, IClock clock = null)
        {
            _store = store ?? throw new ArgumentNullException(nameof(store));
            _clock = clock ?? SystemClock.Instance;
        }

        /// <summary>Most recently played (or joined) first.</summary>
        public IReadOnlyList<LibraryEntry> Entries =>
            Load()
                .OrderByDescending(entry => entry.LastPlayedAt ?? entry.AddedAt, StringComparer.Ordinal)
                .ToList();

        public LibraryEntry Find(string trailId) => Load().FirstOrDefault(entry => entry.TrailId == trailId);

        /// <summary>A trail joined by code: added, or its details refreshed with progress kept.</summary>
        public LibraryEntry Add(JoinedTrailDto joined)
        {
            if (joined == null)
            {
                throw new ArgumentNullException(nameof(joined));
            }

            List<LibraryEntry> entries = Load();
            LibraryEntry entry = entries.FirstOrDefault(candidate => candidate.TrailId == joined.TrailId);
            if (entry == null)
            {
                entry = new LibraryEntry { TrailId = joined.TrailId, AddedAt = Now() };
                entries.Add(entry);
            }

            entry.Name = joined.Name;
            entry.JoinCode = joined.JoinCode;
            entry.PinCount = joined.PinCount;
            entry.ExpiryDays = joined.ExpiryDays;
            Save(entries);
            return entry;
        }

        /// <summary>
        /// Records where the player's attempt on a trail stands. Adds the trail if it isn't listed
        /// yet — a trail opened by id rather than joined by code still belongs on the list.
        /// </summary>
        public void RecordAttempt(TrailDto trail, AttemptDto attempt)
        {
            if (trail == null || attempt == null)
            {
                return;
            }

            List<LibraryEntry> entries = Load();
            LibraryEntry entry = entries.FirstOrDefault(candidate => candidate.TrailId == attempt.TrailId);
            if (entry == null)
            {
                entry = new LibraryEntry { TrailId = attempt.TrailId, AddedAt = Now() };
                entries.Add(entry);
            }

            entry.Name = trail.Name ?? entry.Name;
            entry.ExpiryDays = trail.ExpiryDays;
            entry.PinCount = attempt.Pins.Count;
            entry.PinsCompleted = attempt.Pins.Count(pin => pin.Status == "completed");
            entry.Status = attempt.Status == LibraryStatus.Completed || attempt.Status == LibraryStatus.Expired
                ? attempt.Status
                : LibraryStatus.Active;
            entry.LastPlayedAt = Now();
            Save(entries);
        }

        /// <summary>Takes a trail off the list. The server keeps the attempts; joining again brings it back.</summary>
        public bool Remove(string trailId)
        {
            List<LibraryEntry> entries = Load();
            int removed = entries.RemoveAll(entry => entry.TrailId == trailId);
            if (removed > 0)
            {
                Save(entries);
            }

            return removed > 0;
        }

        private List<LibraryEntry> Load()
        {
            string json = _store.Get(StorageKey);
            if (string.IsNullOrEmpty(json))
            {
                return new List<LibraryEntry>();
            }

            try
            {
                return Json.Deserialize<List<LibraryEntry>>(json) ?? new List<LibraryEntry>();
            }
            catch (Newtonsoft.Json.JsonException)
            {
                // A damaged list loses the shortcuts, not the player's progress (that is on the
                // server); starting it afresh beats refusing to open the app.
                return new List<LibraryEntry>();
            }
        }

        private void Save(List<LibraryEntry> entries) => _store.Set(StorageKey, Json.Serialize(entries));

        private string Now() => IsoTime.ToWire(_clock.UtcNow);
    }
}
