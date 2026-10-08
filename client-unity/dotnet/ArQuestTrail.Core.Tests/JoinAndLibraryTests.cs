using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using ArQuestTrail.Core;
using Xunit;

namespace ArQuestTrail.Core.Tests
{
    public class JoinCodeTests
    {
        [Theory]
        [InlineData("ABCDEFGH", "ABCDEFGH")]
        [InlineData("abcd-efgh", "ABCDEFGH")]
        [InlineData("  AbCd EfGh ", "ABCDEFGH")]
        [InlineData("ab cd - ef gh", "ABCDEFGH")]
        [InlineData("2345-6789", "23456789")]
        public void Normalizes_what_players_type_the_way_the_server_does(string input, string expected)
        {
            Assert.Equal(expected, JoinCode.Normalize(input));
        }

        [Theory]
        [InlineData(null)]
        [InlineData("")]
        [InlineData("ABCDEFG")] // too short
        [InlineData("ABCDEFGHJ")] // too long
        [InlineData("ABCD0FGH")] // 0 is left out of the alphabet (looks like O)
        [InlineData("ABCDOFGH")] // and so is O
        [InlineData("ABCD1FGH")] // 1, I and L too
        [InlineData("ABCDIFGH")]
        [InlineData("ABCDLFGH")]
        [InlineData("ABCD_EFGH")] // only spaces and dashes are separators
        public void Rejects_anything_that_cannot_be_a_code(string input)
        {
            Assert.Null(JoinCode.Normalize(input));
        }

        [Fact]
        public void Formats_a_code_in_two_halves()
        {
            Assert.Equal("ABCD-EFGH", JoinCode.Format("abcdefgh"));
            Assert.Throws<ArgumentException>(() => JoinCode.Format("nope"));
        }

        [Theory]
        [InlineData("ABCD-EFGH")]
        [InlineData("arquest://join/ABCDEFGH")]
        [InlineData("ARQUEST://JOIN/abcd-efgh")]
        [InlineData("https://trails.example.com/join/ABCDEFGH")]
        [InlineData("https://trails.example.com/join/ABCD-EFGH?utm_source=poster")]
        [InlineData("https://example.com/quest/join/ABCDEFGH/")]
        [InlineData("http://192.168.1.20:3000/join/abcdefgh")]
        [InlineData("  https://trails.example.com/join/ABCDEFGH  ")]
        public void Finds_the_code_in_a_code_an_app_link_or_a_pasted_page_url(string input)
        {
            Assert.Equal("ABCDEFGH", JoinCode.FromInput(input));
        }

        [Theory]
        [InlineData("")]
        [InlineData("   ")]
        [InlineData("arquest://trail/ABCDEFGH")] // not a join link
        [InlineData("arquest://join/")]
        [InlineData("https://trails.example.com/trails/ABCDEFGH")]
        [InlineData("https://trails.example.com/join/")]
        [InlineData("https://trails.example.com/join/NOT-A-CODE")]
        [InlineData("ftp://trails.example.com/join/ABCDEFGH")]
        [InlineData("javascript://join/ABCDEFGH")]
        public void Finds_nothing_where_there_is_no_code(string input)
        {
            Assert.Null(JoinCode.FromInput(input));
        }
    }

    public class TrailLibraryTests
    {
        private static readonly DateTimeOffset T0 = new DateTimeOffset(2026, 5, 1, 9, 0, 0, TimeSpan.Zero);

        private readonly InMemoryKeyValueStore _store = new InMemoryKeyValueStore();
        private readonly FakeClock _clock = new FakeClock(T0);

        private TrailLibrary Library() => new TrailLibrary(_store, _clock);

        private static JoinedTrailDto Joined(string trailId, string name = "Marina Walk", int pins = 3) =>
            new JoinedTrailDto { TrailId = trailId, Name = name, JoinCode = "ABCD-EFGH", PinCount = pins, ExpiryDays = 7 };

        private static AttemptDto Attempt(string trailId, string status, params string[] pinStatuses) => new AttemptDto
        {
            AttemptId = "a-" + trailId,
            TrailId = trailId,
            Status = status,
            Pins = pinStatuses.Select((s, i) => new AttemptPinDto { PinId = "p" + i, SequenceIndex = i + 1, Status = s }).ToList(),
        };

        [Fact]
        public void Remembers_a_joined_trail_across_restarts()
        {
            Library().Add(Joined("t-1"));

            LibraryEntry entry = Library().Find("t-1");

            Assert.Equal("Marina Walk", entry.Name);
            Assert.Equal("ABCD-EFGH", entry.JoinCode);
            Assert.Equal(3, entry.PinCount);
            Assert.Equal(7, entry.ExpiryDays);
            Assert.Equal(LibraryStatus.NotStarted, entry.Status);
            Assert.Equal("2026-05-01T09:00:00.000Z", entry.AddedAt);
        }

        [Fact]
        public void Joining_again_refreshes_the_details_and_keeps_the_progress()
        {
            TrailLibrary library = Library();
            library.Add(Joined("t-1"));
            library.RecordAttempt(new TrailDto { Name = "Marina Walk" }, Attempt("t-1", "active", "completed", "unlocked", "locked"));

            _clock.Advance(TimeSpan.FromDays(1));
            library.Add(Joined("t-1", name: "Marina Heritage Walk", pins: 4));

            LibraryEntry entry = Assert.Single(library.Entries);
            Assert.Equal("Marina Heritage Walk", entry.Name);
            Assert.Equal(LibraryStatus.Active, entry.Status);
            Assert.Equal(1, entry.PinsCompleted);
            Assert.Equal("2026-05-01T09:00:00.000Z", entry.AddedAt);
        }

        [Theory]
        [InlineData("active", LibraryStatus.Active)]
        [InlineData("completed", LibraryStatus.Completed)]
        [InlineData("expired", LibraryStatus.Expired)]
        public void Records_where_the_attempt_stands(string attemptStatus, string expected)
        {
            TrailLibrary library = Library();
            library.Add(Joined("t-1"));

            library.RecordAttempt(new TrailDto { Name = "Marina Walk", ExpiryDays = 7 }, Attempt("t-1", attemptStatus, "completed", "completed", "unlocked"));

            LibraryEntry entry = library.Find("t-1");
            Assert.Equal(expected, entry.Status);
            Assert.Equal(2, entry.PinsCompleted);
            Assert.Equal(3, entry.PinCount);
            Assert.NotNull(entry.LastPlayedAt);
        }

        [Fact]
        public void Lists_a_trail_opened_by_id_even_though_it_was_never_joined_by_code()
        {
            TrailLibrary library = Library();

            library.RecordAttempt(new TrailDto { Name = "Seeded trail" }, Attempt("t-9", "active", "unlocked"));

            LibraryEntry entry = Assert.Single(library.Entries);
            Assert.Equal("Seeded trail", entry.Name);
            Assert.Null(entry.JoinCode);
        }

        [Fact]
        public void Lists_the_most_recently_played_trail_first()
        {
            TrailLibrary library = Library();
            library.Add(Joined("t-1", name: "First"));
            _clock.Advance(TimeSpan.FromMinutes(1));
            library.Add(Joined("t-2", name: "Second"));
            _clock.Advance(TimeSpan.FromMinutes(1));
            library.RecordAttempt(new TrailDto { Name = "First" }, Attempt("t-1", "active", "unlocked"));

            Assert.Equal(new[] { "First", "Second" }, library.Entries.Select(e => e.Name));
        }

        [Fact]
        public void Removes_a_trail_from_the_list()
        {
            TrailLibrary library = Library();
            library.Add(Joined("t-1"));

            Assert.True(library.Remove("t-1"));
            Assert.False(library.Remove("t-1"));
            Assert.Empty(library.Entries);
        }

        [Fact]
        public void Starts_afresh_rather_than_crashing_on_a_damaged_list()
        {
            _store.Set("trail_library", "{not json");
            TrailLibrary library = Library();

            Assert.Empty(library.Entries);
            library.Add(Joined("t-1"));
            Assert.Single(library.Entries);
        }
    }

    public class JoinSessionTests
    {
        private static readonly DateTimeOffset T0 = new DateTimeOffset(2026, 5, 1, 9, 0, 0, TimeSpan.Zero);

        private readonly FakeServer _server = new FakeServer();
        private readonly InMemoryKeyValueStore _data = new InMemoryKeyValueStore();
        private readonly InMemoryKeyValueStore _secure = new InMemoryKeyValueStore();

        private (QuestSession Session, FakeTransport Transport) NewSession()
        {
            FakeTransport transport = _server.Transport;
            var identity = new DeviceIdentity(_secure);
            var api = new QuestApiClient(transport, "https://api.example.test", identity, new FakeClock(T0));
            var session = new QuestSession(api, _data, identity, new FakeClock(T0));
            session.History.MarkSessionStarted(T0);
            return (session, transport);
        }

        private void PublishJoinable(string trailId = "t-1", string code = "ABCDEFGH")
        {
            (double lat2, double lng2) = Geo.EastOf(13.0827, 80.2707, 300);
            _server.Publish(
                trailId,
                (13.0827, 80.2707, ChallengeTypes.ProximityDwell, null),
                (lat2, lng2, ChallengeTypes.ProximityDwell, null));
            _server.AssignJoinCode(trailId, code);
        }

        [Theory]
        [InlineData("abcd-efgh")]
        [InlineData("arquest://join/ABCDEFGH")]
        [InlineData("https://trails.example.com/join/ABCDEFGH")]
        public async Task Joins_by_code_or_link_and_puts_the_trail_on_the_list(string input)
        {
            PublishJoinable();
            (QuestSession session, FakeTransport transport) = NewSession();

            ApiResult<LibraryEntry> joined = await session.JoinAsync(input);

            Assert.True(joined.Ok, joined.Error?.ToString());
            Assert.Equal("t-1", joined.Value.TrailId);
            Assert.Equal("ABCD-EFGH", joined.Value.JoinCode);
            Assert.Equal(2, joined.Value.PinCount);
            Assert.Equal("t-1", Assert.Single(session.Library.Entries).TrailId);
            Assert.Contains(transport.Requests, r => r.Url.EndsWith("/api/v1/join/ABCDEFGH", StringComparison.Ordinal));
        }

        [Fact]
        public async Task Refuses_a_malformed_code_without_a_request()
        {
            (QuestSession session, FakeTransport transport) = NewSession();

            ApiResult<LibraryEntry> joined = await session.JoinAsync("not a code");

            Assert.False(joined.Ok);
            Assert.Equal("invalid_join_code", joined.Error.Code);
            Assert.Empty(transport.Requests);
        }

        [Fact]
        public async Task Reports_an_unknown_code_and_adds_nothing()
        {
            PublishJoinable();
            (QuestSession session, _) = NewSession();

            ApiResult<LibraryEntry> joined = await session.JoinAsync("ZZZZ-ZZZZ");

            Assert.Equal(ApiErrorKind.NotFound, joined.Error.Kind);
            Assert.Equal("join_code_not_found", joined.Error.Code);
            Assert.Empty(session.Library.Entries);
        }

        [Fact]
        public async Task Says_offline_rather_than_unknown_when_there_is_no_connection()
        {
            PublishJoinable();
            _server.Offline = true;
            (QuestSession session, _) = NewSession();

            ApiResult<LibraryEntry> joined = await session.JoinAsync("ABCD-EFGH");

            Assert.Equal(ApiErrorKind.Network, joined.Error.Kind);
            Assert.True(session.IsOffline);
            Assert.Empty(session.Library.Entries);
        }

        [Fact]
        public async Task Keeps_the_list_in_step_with_play()
        {
            PublishJoinable();
            (QuestSession session, _) = NewSession();
            await session.JoinAsync("ABCD-EFGH");

            TrailProgress progress = (await session.StartOrResumeAsync("t-1")).Value;
            Assert.Equal(LibraryStatus.Active, session.Library.Find("t-1").Status);

            foreach (PinView view in progress.Pins.ToList())
            {
                PinDto pin = view.Pin;
                await session.SubmitCompletionAsync(pin, new LocationFix(pin.Lat, pin.Lng, 5, T0.AddMinutes(pin.SequenceIndex)));
            }

            LibraryEntry entry = session.Library.Find("t-1");
            Assert.Equal(LibraryStatus.Completed, entry.Status);
            Assert.Equal(2, entry.PinsCompleted);
        }

        [Fact]
        public async Task Forgets_the_list_with_the_rest_of_the_players_data()
        {
            PublishJoinable();
            (QuestSession session, _) = NewSession();
            await session.JoinAsync("ABCD-EFGH");

            ApiResult<DeleteMyDataResponse> deleted = await session.DeleteMyDataAsync();

            Assert.True(deleted.Ok);
            Assert.Empty(session.Library.Entries);
        }
    }

    public class AppFlowTests
    {
        private readonly InMemoryKeyValueStore _store = new InMemoryKeyValueStore();

        [Fact]
        public void First_run_explains_the_game_then_location_then_lists_trails()
        {
            var flow = new AppFlow(_store);
            var seen = new List<AppScreen>();
            flow.ScreenChanged += seen.Add;

            flow.Start(locationGranted: false);
            Assert.Equal(AppScreen.Welcome, flow.Screen);

            flow.ContinueFromWelcome(locationGranted: false);
            flow.LocationPermissionAnswered();

            Assert.Equal(new[] { AppScreen.LocationPermission, AppScreen.MyTrails }, seen);
        }

        [Fact]
        public void Skips_the_location_explanation_when_the_platform_already_granted_it()
        {
            var flow = new AppFlow(_store);
            flow.Start(locationGranted: true);

            flow.ContinueFromWelcome(locationGranted: true);

            Assert.Equal(AppScreen.MyTrails, flow.Screen);
        }

        [Fact]
        public void Later_launches_go_straight_to_the_trail_list()
        {
            var first = new AppFlow(_store);
            first.Start(null);
            first.ContinueFromWelcome(false);
            first.LocationPermissionAnswered();

            var later = new AppFlow(_store);
            later.Start(locationGranted: null); // iOS: unknown — asking once counts as answered

            Assert.Equal(AppScreen.MyTrails, later.Screen);
        }

        [Fact]
        public void Asks_again_on_a_later_launch_where_the_platform_says_location_is_still_off()
        {
            var first = new AppFlow(_store);
            first.Start(false);
            first.ContinueFromWelcome(false);
            first.LocationPermissionAnswered();

            var later = new AppFlow(_store);
            later.Start(locationGranted: false); // Android: the player said no last time

            Assert.Equal(AppScreen.LocationPermission, later.Screen);
        }

        [Fact]
        public void A_link_that_opened_the_app_waits_for_first_run_setup_then_opens_the_join_screen()
        {
            var flow = new AppFlow(_store);
            flow.Start(false);

            Assert.True(flow.HandleLink("arquest://join/ABCD-EFGH"));
            Assert.Equal(AppScreen.Welcome, flow.Screen);

            flow.ContinueFromWelcome(false);
            flow.LocationPermissionAnswered();

            Assert.Equal(AppScreen.JoinTrail, flow.Screen);
            Assert.Equal("ABCDEFGH", flow.PendingJoinCode);
        }

        [Fact]
        public void A_link_arriving_while_the_app_is_open_goes_to_the_join_screen()
        {
            AppFlow flow = SetUp();
            flow.OpenTrail("t-1");
            flow.Play();

            flow.HandleLink("https://trails.example.com/join/ABCDEFGH");

            Assert.Equal(AppScreen.JoinTrail, flow.Screen);
            Assert.Equal("ABCDEFGH", flow.PendingJoinCode);
        }

        [Fact]
        public void Ignores_a_link_with_no_code_in_it()
        {
            AppFlow flow = SetUp();

            Assert.False(flow.HandleLink("arquest://settings"));
            Assert.Equal(AppScreen.MyTrails, flow.Screen);
            Assert.Null(flow.PendingJoinCode);
        }

        [Fact]
        public void Join_then_play_then_back_out_to_the_list()
        {
            AppFlow flow = SetUp();
            flow.HandleLink("arquest://join/ABCDEFGH");

            flow.Joined("t-1");
            Assert.Equal(AppScreen.TrailDetails, flow.Screen);
            Assert.Null(flow.PendingJoinCode);

            flow.Play();
            Assert.Equal(AppScreen.Playing, flow.Screen);

            flow.Back();
            Assert.Equal(AppScreen.TrailDetails, flow.Screen);
            flow.Back();
            Assert.Equal(AppScreen.MyTrails, flow.Screen);
            Assert.Equal("t-1", flow.SelectedTrailId);
        }

        [Fact]
        public void Leaving_the_join_screen_drops_the_code_a_link_brought()
        {
            AppFlow flow = SetUp();
            flow.HandleLink("arquest://join/ABCDEFGH");

            flow.Back();

            Assert.Equal(AppScreen.MyTrails, flow.Screen);
            Assert.Null(flow.PendingJoinCode);
        }

        [Fact]
        public void Cannot_play_without_a_trail()
        {
            AppFlow flow = SetUp();

            Assert.Throws<InvalidOperationException>(() => flow.Play());
            flow.Play("t-7"); // the Editor shortcut names the trail directly
            Assert.Equal(AppScreen.Playing, flow.Screen);
        }

        [Fact]
        public void Removing_a_trail_returns_to_the_list()
        {
            AppFlow flow = SetUp();
            flow.OpenTrail("t-1");

            flow.TrailRemoved();

            Assert.Equal(AppScreen.MyTrails, flow.Screen);
            Assert.Null(flow.SelectedTrailId);
        }

        [Fact]
        public void Deleting_the_players_data_makes_the_next_screen_a_first_run()
        {
            AppFlow flow = SetUp();
            flow.OpenTrail("t-1");
            flow.OpenSettings();

            _store.Clear(); // what QuestSession.DeleteMyDataAsync does to the device store
            flow.PlayerDataDeleted();

            Assert.Equal(AppScreen.Welcome, flow.Screen);
            Assert.Null(flow.SelectedTrailId);
            Assert.False(flow.HasOnboarded);
            Assert.False(flow.HasAskedForLocation);
        }

        private AppFlow SetUp()
        {
            var flow = new AppFlow(_store);
            flow.Start(true);
            flow.ContinueFromWelcome(true);
            return flow;
        }
    }
}
