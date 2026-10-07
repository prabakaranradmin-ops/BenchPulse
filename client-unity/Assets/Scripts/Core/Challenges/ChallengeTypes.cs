namespace ArQuestTrail.Core
{
    /// <summary>GDR-02's challenge types, as the server spells them.</summary>
    public static class ChallengeTypes
    {
        public const string ProximityDwell = "proximity_dwell";
        public const string PhotoConfirmation = "photo_confirmation";
        public const string CodeEntry = "code_entry";

        /// <summary>Used when a dwell pin was authored without <c>dwell_seconds</c>.</summary>
        public const int DefaultDwellSeconds = 15;

        /// <summary>
        /// Whether the device can know a completion is good before the server confirms it. This
        /// decides what happens offline (SR-NET-02): a dwell pin is judged by exactly the rule
        /// the server applies, so the next pin can unlock optimistically. A code is only ever
        /// checked server-side — its answer never reaches the device — so the trail waits for
        /// the server instead of letting a player walk on past a wrong code.
        /// </summary>
        public static bool CanVerifyOnDevice(string challengeType) => challengeType == ProximityDwell;

        /// <summary>ST-6.1 isn't built; the server refuses these pins, so the client must not offer them.</summary>
        public static bool IsSupported(string challengeType) =>
            challengeType == ProximityDwell || challengeType == CodeEntry;
    }
}
