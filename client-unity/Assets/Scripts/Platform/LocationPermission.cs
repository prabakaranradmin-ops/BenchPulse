using System;
using UnityEngine;
#if UNITY_ANDROID
using UnityEngine.Android;
#endif

namespace ArQuestTrail
{
    /// <summary>
    /// The operating system's location permission, asked for only after the app has explained why
    /// (the LocationPermission screen) — never cold at launch.
    /// </summary>
    public static class LocationPermission
    {
        /// <summary>
        /// True/false where the platform can say (Android); null where it can't before asking
        /// (iOS only reports authorization once the location service is started).
        /// </summary>
        public static bool? IsGranted()
        {
#if UNITY_EDITOR
            return true;
#elif UNITY_ANDROID
            return Permission.HasUserAuthorizedPermission(Permission.FineLocation);
#else
            return null;
#endif
        }

        /// <summary>
        /// Shows the system prompt; <paramref name="answered"/> runs once the player has chosen. On
        /// Android it can run on a Java thread rather than Unity's main thread, so it must only hand
        /// the answer over, not touch Unity objects itself.
        /// </summary>
        public static void Request(Action<bool> answered)
        {
#if UNITY_EDITOR
            answered(true);
#elif UNITY_ANDROID
            if (Permission.HasUserAuthorizedPermission(Permission.FineLocation))
            {
                answered(true);
                return;
            }

            var callbacks = new PermissionCallbacks();
            // A "don't ask again" denial also lands in PermissionDenied when nothing subscribes to
            // its own event — and either way, the answer is no.
            callbacks.PermissionGranted += _ => answered(true);
            callbacks.PermissionDenied += _ => answered(false);
            Permission.RequestUserPermission(Permission.FineLocation, callbacks);
#else
            // iOS asks when the location service starts, which the caller does next.
            answered(Input.location.isEnabledByUser);
#endif
        }
    }
}
