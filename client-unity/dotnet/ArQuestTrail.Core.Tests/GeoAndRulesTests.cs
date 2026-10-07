using System;
using ArQuestTrail.Core;
using Xunit;

namespace ArQuestTrail.Core.Tests
{
    public class GeoMathTests
    {
        [Fact]
        public void One_degree_of_latitude_is_the_same_length_the_server_uses()
        {
            // π·6371000/180 — the server's EARTH_RADIUS_M sphere, not a rounded 111320.
            Assert.Equal(111194.9266, GeoMath.HaversineMeters(0, 0, 1, 0), 3);
        }

        [Fact]
        public void Distance_is_zero_to_itself_and_symmetric()
        {
            Assert.Equal(0, GeoMath.HaversineMeters(13.0827, 80.2707, 13.0827, 80.2707));
            Assert.Equal(
                GeoMath.HaversineMeters(51.5, -0.12, 51.51, -0.1),
                GeoMath.HaversineMeters(51.51, -0.1, 51.5, -0.12),
                9);
        }

        [Theory]
        [InlineData(0)]
        [InlineData(13.0827)]
        [InlineData(51.5074)]
        [InlineData(-33.8688)]
        public void Enu_offsets_round_trip_and_agree_with_haversine(double lat)
        {
            var origin = new GeoPoint(lat, 80.27);

            foreach (double meters in new[] { 10.0, 60.0, 300.0, 2000.0 })
            {
                GeoPoint moved = GeoMath.FromEnu(origin, new EnuOffset(meters, 0, 0));
                EnuOffset back = GeoMath.ToEnu(origin, moved);

                Assert.Equal(meters, back.East, 6);
                Assert.Equal(0, back.North, 6);
                // Flat-earth vs great circle: within a centimetre at 2km is the claim that matters.
                Assert.Equal(meters, GeoMath.HaversineMeters(origin.Lat, origin.Lng, moved.Lat, moved.Lng), 2);
            }
        }

        [Fact]
        public void Enu_up_is_the_altitude_difference_only_when_both_points_have_one()
        {
            Assert.Equal(5, GeoMath.ToEnu(new GeoPoint(0, 0, 10), new GeoPoint(0, 0, 15)).Up);
            Assert.Equal(0, GeoMath.ToEnu(new GeoPoint(0, 0), new GeoPoint(0, 0, 15)).Up);
        }

        [Theory]
        [InlineData(0.001, 0, 0, "N")]
        [InlineData(0, 0.001, 90, "E")]
        [InlineData(-0.001, 0, 180, "S")]
        [InlineData(0, -0.001, 270, "W")]
        [InlineData(0.001, 0.001, 45, "NE")]
        public void Bearings_and_compass_points(double dLat, double dLng, double expected, string point)
        {
            double bearing = GeoMath.BearingDegrees(0, 0, dLat, dLng);

            Assert.Equal(expected, bearing, 1);
            Assert.Equal(point, GeoMath.ToCompassPoint(bearing));
        }

        [Fact]
        public void A_bearing_just_short_of_north_is_still_north()
        {
            Assert.Equal("N", GeoMath.ToCompassPoint(359));
            Assert.Equal("N", GeoMath.ToCompassPoint(-10));
        }
    }

    /// <summary>
    /// Ported case for case from server/src/services/completion.test.ts. If one of these
    /// disagrees with its server twin, a player sees a pin complete locally and then get rejected.
    /// </summary>
    public class CompletionRulesTests
    {
        // The server suite's own fixture: metres → degrees at 111320 m/°, pin at (0, 0), 10m radius.
        private const double ServerFixtureMetersPerDegree = 111320;

        private static double EastOfPin(double meters) => meters / ServerFixtureMetersPerDegree;

        [Fact]
        public void Accepts_a_fix_inside_the_radius_when_accuracy_is_tighter_than_the_radius()
        {
            PositionEvaluation result = CompletionRules.Evaluate(0, 0, 10, 0, EastOfPin(6), 4);

            Assert.True(result.IsWithin);
            Assert.Equal(10, result.EffectiveRadiusM);
            Assert.Equal(6, result.DistanceM, 0);
        }

        [Fact]
        public void Widens_the_effective_radius_to_a_looser_reported_accuracy()
        {
            PositionEvaluation result = CompletionRules.Evaluate(0, 0, 10, 0, EastOfPin(20), 25);

            Assert.True(result.IsWithin);
            Assert.Equal(25, result.EffectiveRadiusM);
        }

        [Fact]
        public void Caps_the_effective_radius_at_the_ceiling()
        {
            PositionEvaluation result = CompletionRules.Evaluate(0, 0, 10, 0, EastOfPin(48), CompletionRules.AccuracyCeilingM);

            Assert.Equal(CompletionRules.AccuracyCeilingM, result.EffectiveRadiusM);
            Assert.True(result.IsWithin);
        }

        [Fact]
        public void Rejects_a_fix_outside_the_effective_radius()
        {
            PositionEvaluation result = CompletionRules.Evaluate(0, 0, 10, 0, EastOfPin(120), 5);

            Assert.Equal(PositionVerdict.OutsideEffectiveRadius, result.Verdict);
            Assert.Equal(120, result.DistanceM, 0);
        }

        [Fact]
        public void Reports_weak_gps_instead_of_guessing_when_accuracy_exceeds_the_ceiling()
        {
            PositionEvaluation result = CompletionRules.Evaluate(0, 0, 10, 0, 0, CompletionRules.AccuracyCeilingM + 30);

            Assert.Equal(PositionVerdict.AccuracyExceedsCeiling, result.Verdict);
        }

        [Fact]
        public void Caps_a_pin_authored_wider_than_the_ceiling()
        {
            // The pre-Core Unity stub got this wrong: it used max(radius, accuracy) uncapped, so a
            // 60m pin would complete on the device at 55m and then be rejected by the server.
            PositionEvaluation result = CompletionRules.Evaluate(0, 0, 60, 0, EastOfPin(55), 5);

            Assert.Equal(50, result.EffectiveRadiusM);
            Assert.Equal(PositionVerdict.OutsideEffectiveRadius, result.Verdict);
        }

        [Fact]
        public void Accuracy_exactly_at_the_ceiling_is_still_usable()
        {
            // Strict '>' on the server: 50m is the last accuracy it accepts.
            Assert.NotEqual(
                PositionVerdict.AccuracyExceedsCeiling,
                CompletionRules.Evaluate(0, 0, 10, 0, 0, 50).Verdict);
            Assert.Equal(
                PositionVerdict.AccuracyExceedsCeiling,
                CompletionRules.Evaluate(0, 0, 10, 0, 0, 50.0001).Verdict);
        }
    }

    public class DistanceFadeTests
    {
        [Fact]
        public void Is_fully_visible_inside_the_fade_start_and_never_invisible_beyond_the_end()
        {
            var fade = new DistanceFade(fadeStartM: 15, fadeEndM: 60, minAlpha: 0.25, minScale: 0.6);

            Assert.Equal(1, fade.Alpha(5));
            Assert.Equal(1, fade.Scale(15));
            Assert.Equal(0.25, fade.Alpha(500), 9);
            Assert.Equal(0.6, fade.Scale(500), 9);
        }

        [Fact]
        public void Fades_linearly_in_between()
        {
            var fade = new DistanceFade(15, 55, 0.2, 0.6);

            Assert.Equal(0.5, fade.FadeAmount(35), 9);
            Assert.Equal(0.6, fade.Alpha(35), 9);
        }

        [Fact]
        public void Refuses_a_fade_that_ends_before_it_starts()
        {
            Assert.Throws<ArgumentException>(() => new DistanceFade(30, 30));
        }
    }

    public class IsoTimeTests
    {
        [Fact]
        public void Matches_javascript_toISOString_exactly()
        {
            var time = new DateTimeOffset(2026, 3, 1, 10, 0, 5, 123, TimeSpan.FromHours(5.5));

            Assert.Equal("2026-03-01T04:30:05.123Z", IsoTime.ToWire(time));
        }

        [Fact]
        public void Round_trips_through_the_wire_format()
        {
            DateTimeOffset time = IsoTime.TruncateToMilliseconds(new DateTimeOffset(2026, 10, 7, 22, 15, 3, TimeSpan.Zero).AddTicks(1234567));

            Assert.Equal(time, IsoTime.FromWire(IsoTime.ToWire(time)));
        }

        [Fact]
        public void Truncation_drops_only_sub_millisecond_ticks()
        {
            var time = new DateTimeOffset(2026, 1, 1, 0, 0, 0, 7, TimeSpan.Zero).AddTicks(9999);

            Assert.Equal(new DateTimeOffset(2026, 1, 1, 0, 0, 0, 7, TimeSpan.Zero), IsoTime.TruncateToMilliseconds(time));
        }
    }
}
