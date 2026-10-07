using System;
using System.Linq;
using ArQuestTrail.Core;
using Xunit;

namespace ArQuestTrail.Core.Tests
{
    public class DwellTrackerTests
    {
        private static readonly DateTimeOffset T0 = new DateTimeOffset(2026, 5, 1, 9, 0, 0, TimeSpan.Zero);

        private const double PinLat = 13.0827;
        private const double PinLng = 80.2707;

        private static LocationFix At(double secondsAfterStart, double metersEast = 0, double accuracyM = 5)
        {
            (double lat, double lng) = Geo.EastOf(PinLat, PinLng, metersEast);
            return new LocationFix(lat, lng, accuracyM, T0.AddSeconds(secondsAfterStart));
        }

        private static DwellTracker Tracker(double seconds = 15) => new DwellTracker(PinLat, PinLng, 10, seconds);

        [Fact]
        public void Is_satisfied_once_the_player_has_stayed_inside_for_the_required_time()
        {
            DwellTracker tracker = Tracker();

            for (int s = 0; s < 15; s++)
            {
                Assert.Equal(DwellState.Dwelling, tracker.Update(At(s)));
            }

            Assert.Equal(DwellState.Satisfied, tracker.Update(At(15)));
            Assert.Equal(1, tracker.Progress);
            Assert.Equal(T0.AddSeconds(15), tracker.CompletionFix.Value.RecordedAt);
        }

        [Fact]
        public void Reports_progress_while_dwelling()
        {
            DwellTracker tracker = Tracker(20);

            tracker.Update(At(0));
            tracker.Update(At(5));

            Assert.Equal(0.25, tracker.Progress, 9);
        }

        [Fact]
        public void Leaving_the_radius_restarts_the_dwell()
        {
            DwellTracker tracker = Tracker();
            for (int s = 0; s <= 10; s++)
            {
                tracker.Update(At(s));
            }

            Assert.Equal(DwellState.OutsideRadius, tracker.Update(At(11, metersEast: 40)));
            Assert.Equal(0, tracker.ElapsedSeconds);

            // A full 15 seconds again, counted from re-entry at 12s.
            for (int s = 12; s <= 26; s++)
            {
                Assert.Equal(DwellState.Dwelling, tracker.Update(At(s)));
            }

            Assert.Equal(DwellState.Satisfied, tracker.Update(At(27)));
        }

        [Fact]
        public void Reports_the_distance_for_a_move_closer_hint()
        {
            DwellTracker tracker = Tracker();

            tracker.Update(At(0, metersEast: 34));

            Assert.Equal(DwellState.OutsideRadius, tracker.State);
            Assert.Equal(34, tracker.LastEvaluation.Value.DistanceM, 1);
        }

        [Fact]
        public void Weak_signal_shows_the_hint_and_never_completes_even_on_top_of_the_pin()
        {
            DwellTracker tracker = Tracker(1);

            Assert.Equal(DwellState.WeakSignal, tracker.Update(At(0, accuracyM: 80)));
            Assert.Equal(DwellState.WeakSignal, tracker.Update(At(5, accuracyM: 80)));
            Assert.Null(tracker.CompletionFix);
        }

        [Fact]
        public void A_long_silence_between_fixes_restarts_rather_than_crediting_the_gap()
        {
            DwellTracker tracker = Tracker();
            tracker.Update(At(0));
            tracker.Update(At(3));

            // Nine minutes in the background — nobody knows where the player was.
            Assert.Equal(DwellState.Dwelling, tracker.Update(At(543)));
            Assert.Equal(0, tracker.ElapsedSeconds);
        }

        [Fact]
        public void Duplicate_and_out_of_order_fixes_add_no_time()
        {
            DwellTracker tracker = Tracker();
            tracker.Update(At(0));
            tracker.Update(At(8));

            tracker.Update(At(8));
            tracker.Update(At(4));

            Assert.Equal(8, tracker.ElapsedSeconds);
        }

        [Fact]
        public void Stays_satisfied_once_satisfied()
        {
            DwellTracker tracker = Tracker(2);
            tracker.Update(At(0));
            tracker.Update(At(2));

            Assert.Equal(DwellState.Satisfied, tracker.Update(At(3, metersEast: 500)));
        }

        [Fact]
        public void Reset_starts_over_after_a_server_rejection()
        {
            DwellTracker tracker = Tracker(2);
            tracker.Update(At(0));
            tracker.Update(At(2));

            tracker.Reset();

            Assert.Equal(DwellState.WaitingForFix, tracker.State);
            Assert.Null(tracker.CompletionFix);
            Assert.Equal(DwellState.Dwelling, tracker.Update(At(3)));
        }

        [Fact]
        public void Takes_its_duration_from_the_pin_or_the_default()
        {
            var pin = new PinDto { Lat = PinLat, Lng = PinLng, RadiusM = 10, Challenge = new ChallengeInfo { DwellSeconds = 30 } };
            var bare = new PinDto { Lat = PinLat, Lng = PinLng, RadiusM = 10, Challenge = null };

            Assert.Equal(30, DwellTracker.ForPin(pin).RequiredSeconds);
            Assert.Equal(ChallengeTypes.DefaultDwellSeconds, DwellTracker.ForPin(bare).RequiredSeconds);
        }
    }

    public class LocationHistoryBufferTests
    {
        private static readonly DateTimeOffset T0 = new DateTimeOffset(2026, 5, 1, 9, 0, 0, TimeSpan.Zero);

        private static LocationFix Fix(double seconds) => new LocationFix(0, 0, 5, T0.AddSeconds(seconds));

        [Fact]
        public void Keeps_only_the_trailing_window_the_server_looks_at()
        {
            var buffer = new LocationHistoryBuffer(TimeSpan.FromSeconds(120));
            for (int s = 0; s <= 300; s += 10)
            {
                buffer.Add(Fix(s));
            }

            var snapshot = buffer.Snapshot(T0.AddSeconds(300));

            Assert.Equal(T0.AddSeconds(180), snapshot.First().RecordedAt);
            Assert.Equal(T0.AddSeconds(300), snapshot.Last().RecordedAt);
        }

        [Fact]
        public void Never_exceeds_the_server_array_limit()
        {
            var buffer = new LocationHistoryBuffer(TimeSpan.FromHours(1));
            for (int i = 0; i < 2000; i++)
            {
                buffer.Add(Fix(i * 0.1));
            }

            Assert.Equal(LocationHistoryBuffer.MaxSamples, buffer.Count);
            Assert.Equal(T0.AddSeconds(199.9), buffer.Snapshot(T0.AddSeconds(200)).Last().RecordedAt);
        }

        [Fact]
        public void Ignores_fixes_that_are_not_newer_than_the_last()
        {
            var buffer = new LocationHistoryBuffer();
            buffer.Add(Fix(10));
            buffer.Add(Fix(10));
            buffer.Add(Fix(5));

            Assert.Equal(1, buffer.Count);
        }

        [Fact]
        public void A_snapshot_for_an_earlier_moment_excludes_later_fixes()
        {
            // An offline completion is built at capture time; fixes after it aren't its history.
            var buffer = new LocationHistoryBuffer();
            buffer.Add(Fix(0));
            buffer.Add(Fix(10));
            buffer.Add(Fix(20));

            Assert.Equal(2, buffer.Snapshot(T0.AddSeconds(10)).Count);
        }

        [Fact]
        public void Remembers_the_session_start_for_the_cold_start_grace()
        {
            var buffer = new LocationHistoryBuffer();

            buffer.MarkSessionStarted(T0.AddTicks(1234));

            Assert.Equal(T0, buffer.SessionStartedAt);
        }
    }

    public class PositionSourceSelectorTests
    {
        private static readonly DateTimeOffset T0 = new DateTimeOffset(2026, 5, 1, 9, 0, 0, TimeSpan.Zero);

        private static VpsReading Vps(double horizontal, double heading, bool tracking = true, double seconds = 0) =>
            new VpsReading(true, tracking, 13.08, 80.27, 12, horizontal, heading, T0.AddSeconds(seconds));

        private static LocationFix Gps(double seconds, double accuracy = 8) =>
            new LocationFix(13.0801, 80.2702, accuracy, T0.AddSeconds(seconds));

        [Fact]
        public void Uses_vps_once_it_meets_both_sr_geo_03_thresholds()
        {
            var selector = new PositionSourceSelector();
            selector.RequestLocalization(T0);

            PositionEstimate estimate = selector.Update(Vps(0.4, 3), Gps(0), T0);

            Assert.Equal(LocalizationStatus.Vps, estimate.Status);
            Assert.True(estimate.CanRenderAnchoredPins);
            Assert.False(estimate.IsReducedPrecision);
            Assert.Equal(PositionSource.Vps, estimate.Fix.Value.Source);
            Assert.Equal(0.4, estimate.Fix.Value.AccuracyM);
        }

        [Theory]
        [InlineData(0.6, 3)]
        [InlineData(0.4, 6)]
        public void Waits_while_vps_is_short_of_either_threshold_but_lets_play_continue_on_gps(double horizontal, double heading)
        {
            var selector = new PositionSourceSelector();
            selector.RequestLocalization(T0);

            PositionEstimate estimate = selector.Update(Vps(horizontal, heading), Gps(1), T0.AddSeconds(2));

            Assert.Equal(LocalizationStatus.Localizing, estimate.Status);
            Assert.False(estimate.CanRenderAnchoredPins);
            Assert.Equal(PositionSource.GpsFallback, estimate.Fix.Value.Source);
        }

        [Fact]
        public void Falls_back_to_gps_after_the_timeout_and_says_precision_is_reduced()
        {
            var selector = new PositionSourceSelector(TimeSpan.FromSeconds(5));
            selector.RequestLocalization(T0);

            PositionEstimate estimate = selector.Update(Vps(3, 20), Gps(6), T0.AddSeconds(6));

            Assert.Equal(LocalizationStatus.GpsFallback, estimate.Status);
            Assert.True(estimate.IsReducedPrecision);
        }

        [Fact]
        public void Keeps_the_gps_accuracy_figure_rather_than_flattering_it()
        {
            var selector = new PositionSourceSelector(TimeSpan.FromSeconds(5));
            selector.RequestLocalization(T0);

            PositionEstimate estimate = selector.Update(null, Gps(6, accuracy: 23), T0.AddSeconds(6));

            Assert.Equal(23, estimate.Fix.Value.AccuracyM);
        }

        [Fact]
        public void Falls_back_immediately_when_the_device_cannot_do_vps_at_all()
        {
            var selector = new PositionSourceSelector(TimeSpan.FromSeconds(30));
            selector.RequestLocalization(T0);

            Assert.Equal(LocalizationStatus.GpsFallback, selector.Update(VpsReading.Unsupported(T0), Gps(0), T0).Status);
            Assert.Equal(LocalizationStatus.GpsFallback, selector.Update(null, Gps(0), T0).Status);
        }

        [Fact]
        public void Returns_to_vps_when_it_recovers()
        {
            var selector = new PositionSourceSelector(TimeSpan.FromSeconds(5));
            selector.RequestLocalization(T0);
            selector.Update(Vps(3, 20), Gps(10), T0.AddSeconds(10));

            Assert.Equal(LocalizationStatus.Vps, selector.Update(Vps(0.3, 2), Gps(11), T0.AddSeconds(11)).Status);
        }

        [Fact]
        public void A_brief_vps_loss_after_a_good_fix_waits_again_before_falling_back()
        {
            var selector = new PositionSourceSelector(TimeSpan.FromSeconds(5));
            selector.RequestLocalization(T0);
            selector.Update(Vps(0.3, 2), Gps(0), T0.AddSeconds(60));

            Assert.Equal(LocalizationStatus.Localizing, selector.Update(Vps(2, 2, tracking: false), Gps(62), T0.AddSeconds(62)).Status);
            Assert.Equal(LocalizationStatus.GpsFallback, selector.Update(Vps(2, 2, tracking: false), Gps(66), T0.AddSeconds(66)).Status);
        }

        [Fact]
        public void Ignores_a_stale_gps_fix_and_reports_unavailable()
        {
            var selector = new PositionSourceSelector(TimeSpan.FromSeconds(5), TimeSpan.FromSeconds(15));
            selector.RequestLocalization(T0);

            PositionEstimate estimate = selector.Update(null, Gps(0), T0.AddSeconds(40));

            Assert.Equal(LocalizationStatus.Unavailable, estimate.Status);
            Assert.Null(estimate.Fix);
        }
    }
}
