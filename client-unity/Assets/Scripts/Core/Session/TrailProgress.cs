using System;
using System.Collections.Generic;
using System.Linq;

namespace ArQuestTrail.Core
{
    public enum PinState
    {
        /// <summary>GDR-01: not yet reachable — rendered only as a distance cue, never as a target.</summary>
        Locked,

        /// <summary>The one pin the player can interact with right now.</summary>
        Active,

        Completed,

        /// <summary>Completed on the device and judged by the server's own rule; waiting to sync.</summary>
        CompletedPendingSync,

        /// <summary>Submitted, but only the server can judge it (a code) — the trail waits for it.</summary>
        AwaitingVerification,
    }

    public sealed class PinView
    {
        public PinView(PinDto pin, PinState state)
        {
            Pin = pin;
            State = state;
        }

        public PinDto Pin { get; }
        public PinState State { get; internal set; }

        public bool IsInteractable => State == PinState.Active;
    }

    /// <summary>
    /// A player's progress through one attempt: the server's statuses (the truth), with local,
    /// not-yet-confirmed completions laid over them. Rebuilt from scratch whenever either side
    /// changes, so there is no drift between "what the server said" and "what the device did".
    /// </summary>
    public sealed class TrailProgress
    {
        private readonly List<PinView> _pins;

        public TrailProgress(TrailDto trail, AttemptDto attempt, IEnumerable<PendingCompletion> pending)
        {
            if (trail.TrailVersionId != attempt.TrailVersionId)
            {
                // GDR-07: rendering a different version's pins for this attempt would send the
                // player to coordinates that are not part of the trail they are playing.
                throw new ArgumentException(
                    $"Attempt {attempt.AttemptId} plays version {attempt.TrailVersionId}, not {trail.TrailVersionId}.",
                    nameof(trail));
            }

            Trail = trail;
            _pins = trail.Pins
                .OrderBy(pin => pin.SequenceIndex)
                .Select(pin => new PinView(pin, PinState.Locked))
                .ToList();
            Rebuild(attempt, pending);
        }

        public TrailDto Trail { get; }

        /// <summary>The server's last word on this attempt — overlays excluded.</summary>
        public AttemptDto Attempt { get; private set; }

        public IReadOnlyList<PinView> Pins => _pins;

        /// <summary>GDR-01: the pin to play, or null when the trail is done or waiting on a verification.</summary>
        public PinView ActivePin => _pins.FirstOrDefault(view => view.State == PinState.Active);

        public bool IsAttemptActive => Attempt.Status == "active";

        /// <summary>GDR-04: the server has recorded the final pin.</summary>
        public bool IsCompletedOnServer => Attempt.Status == "completed";

        public bool IsExpired => Attempt.Status == "expired";

        /// <summary>Every pin done on this device, whether or not the server has caught up yet.</summary>
        public bool IsCompletedLocally =>
            _pins.Count > 0
            && _pins.All(view => view.State == PinState.Completed || view.State == PinState.CompletedPendingSync);

        public int UnconfirmedCount => _pins.Count(view =>
            view.State == PinState.CompletedPendingSync || view.State == PinState.AwaitingVerification);

        public PinView Find(string pinId) => _pins.FirstOrDefault(view => view.Pin.PinId == pinId);

        public void Rebuild(AttemptDto attempt, IEnumerable<PendingCompletion> pending)
        {
            Attempt = attempt;

            var serverStatus = attempt.Pins.ToDictionary(pin => pin.PinId, pin => pin.Status);
            foreach (PinView view in _pins)
            {
                serverStatus.TryGetValue(view.Pin.PinId, out string status);
                view.State = status switch
                {
                    "completed" => PinState.Completed,
                    "unlocked" when IsAttemptActive => PinState.Active,
                    _ => PinState.Locked,
                };
            }

            // Replay unconfirmed local completions in the order they happened.
            foreach (PendingCompletion item in pending ?? Enumerable.Empty<PendingCompletion>())
            {
                if (item.AttemptId == attempt.AttemptId)
                {
                    ApplyLocalCompletion(item.PinId, item.ChallengeType);
                }
            }
        }

        /// <summary>
        /// Records a completion the device has submitted but the server hasn't confirmed. Returns
        /// false (and changes nothing) unless the pin is the active one — GDR-01 holds locally too.
        /// </summary>
        public bool ApplyLocalCompletion(string pinId, string challengeType)
        {
            PinView view = Find(pinId);
            if (view == null || view.State != PinState.Active)
            {
                return false;
            }

            if (!ChallengeTypes.CanVerifyOnDevice(challengeType))
            {
                view.State = PinState.AwaitingVerification;
                return true;
            }

            view.State = PinState.CompletedPendingSync;
            int index = _pins.IndexOf(view);
            if (index + 1 < _pins.Count && _pins[index + 1].State == PinState.Locked)
            {
                _pins[index + 1].State = PinState.Active;
            }

            return true;
        }

        /// <summary>
        /// Folds a server confirmation into the server-side truth, for when there's no connection
        /// left to re-fetch the attempt. Mirrors what the server just did: this pin completed, the
        /// next one unlocked, or the attempt closed (GDR-04).
        /// </summary>
        public void ApplyConfirmation(CompletionResponse response, IEnumerable<PendingCompletion> pending)
        {
            foreach (AttemptPinDto pin in Attempt.Pins)
            {
                if (pin.PinId == response.PinId)
                {
                    pin.Status = "completed";
                }
                else if (pin.PinId == response.NextPinId && pin.Status == "locked")
                {
                    pin.Status = "unlocked";
                }
            }

            Attempt.Status = response.AttemptStatus ?? Attempt.Status;
            Attempt.CurrentPinId = response.NextPinId;
            Rebuild(Attempt, pending);
        }
    }
}
