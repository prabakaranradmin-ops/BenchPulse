namespace ArQuestTrail.Core
{
    /// <summary>
    /// SR-NET-01: downloaded trail definitions, so a trail can be browsed and navigated without a
    /// connection. Keyed by version, because an attempt plays one specific version (GDR-07) and a
    /// later republish must not overwrite the coordinates someone mid-trail is walking toward.
    /// </summary>
    public sealed class TrailCache
    {
        private readonly IKeyValueStore _store;

        public TrailCache(IKeyValueStore store)
        {
            _store = store;
        }

        public void Put(TrailDto trail)
        {
            _store.Set(VersionKey(trail.TrailVersionId), Json.Serialize(trail));

            // Only the current version becomes "the" trail for browsing; caching an old version for
            // a resumed attempt must not make a newer one disappear from the trail list.
            if (trail.IsCurrentVersion)
            {
                _store.Set(LatestKey(trail.TrailId), trail.TrailVersionId);
            }
        }

        public TrailDto GetVersion(string trailVersionId)
        {
            string json = _store.Get(VersionKey(trailVersionId));
            return json == null ? null : Json.Deserialize<TrailDto>(json);
        }

        public TrailDto GetLatest(string trailId)
        {
            string versionId = _store.Get(LatestKey(trailId));
            return versionId == null ? null : GetVersion(versionId);
        }

        private static string VersionKey(string trailVersionId) => "trail_version_" + trailVersionId;

        private static string LatestKey(string trailId) => "trail_latest_" + trailId;
    }
}
