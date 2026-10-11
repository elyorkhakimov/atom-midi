# Native Android app (in progress)

Low-latency Android version: native MIDI + Oboe audio, with the existing UI in a WebView.
Why: on the OnePlus 12, Chrome's speaker→mic round trip is ~215–245 ms vs 41.65 ms native (OboeTester).

How it fits together:
- `MainActivity` hosts `dist/` (the normal web build) in a WebView at `https://appassets.androidplatform.net/`.
- The ATOM is opened with the NDK MIDI API (`cpp/midi.cpp`). The page gets a Web MIDI stand-in
  (`src/native/nativeMidi.ts`), so `AtomDriver` and all games run unchanged.
- All sound plays on the native Oboe engine (`cpp/engine.cpp`): kits (port of `src/audio/engine.ts`),
  synth (port of `src/audio/synth.ts`), cues and metronome. The page opens no audio output of its own
  (it only builds/decodes buffers in an OfflineAudioContext).
- "Live" pads sound straight from the MIDI thread, before the page sees the hit: Free jam (kit and
  synth pages) and Rhythm copy, chosen with `AudioEngine.setLivePads()`. Input shaping (threshold,
  curve, double-trigger) is mirrored natively so both sides make the same decisions. Pad hit lights
  are sent from the MIDI thread too, from a table `AtomDriver` keeps up to date.
- Settings shows the native stream (MMAP/legacy, buffer, latency, glitches, last opens, package).

### Low-latency audio on OnePlus (package name)

OnePlus/ColorOS only grants the MMAP fast path to package names on a system allow list
(`/system_ext/etc/Multimedia_Daemon_List.xml`, `aaudio-compatible-apps`); everyone else gets the
legacy mixer ("aaudio denied with imcompatible policy" in logcat). Measured on a OnePlus 12:
legacy 384-frame buffer, ~29 ms output; allow-listed: MMAP exclusive, 96 frames (one 2 ms burst,
the floor set by `aaudio.hw_burst_min_usec`), ~6 ms output. Builds therefore use the allow-listed
`android.nativemedia.aaudio` (not a published app) unless `-PappId=net.padgames.app` is given.
For personal sideloading only. An OTA update to the list could take it away; Settings would show `legacy`.

## Build environment

Everything (JDK 17, Android SDK, NDK, CMake, adb) lives in a container in its own Colima profile,
`android` (vz + Rosetta, since the Linux NDK and aapt2 are x86_64 only). Nothing is installed on the Mac.

```sh
npm run build                            # web app -> dist/ (bundled into the APK)
android/env/run.sh ./gradlew assembleDebug   # -> android/app/build/outputs/apk/debug/app-debug.apk
android/env/run.sh                       # shell in the container (repo at /work)
android/env/run.sh adb devices
colima stop android                      # free the VM's 8 GB RAM when done
```

The first run builds the image (~4.5 GB). Gradle caches and adb keys are kept in Docker volumes.

The VM's disks live on WD1TB in `/Volumes/WD1TB/colima-android/` (this Colima version ignores
`COLIMA_HOME`, so `~/.colima/_lima/colima-android/disk` and `~/.colima/_lima/_disks/colima-android`
are symlinks to it; the drive must be mounted to start the VM).

## Release APK (no developer mode needed)

```sh
npm run build && android/env/run.sh ./gradlew assembleRelease
# -> android/app/build/outputs/apk/release/app-release.apk
```

Copy it to the phone and open it (allow "Install unknown apps" for the app you open it with).
Signed with `android/signing/release.jks` (git-ignored; password in `signing/keystore.properties`).
**Back these up:** updates must be signed with the same key, or the app has to be uninstalled
first, which wipes its settings and best scores. Bump `versionCode` in `app/build.gradle.kts` for each update.

## Installing over wireless debugging (development)

The phone's USB-C port is taken by the ATOM, so use wireless debugging (Developer options → Wireless debugging):

```sh
android/env/run.sh sh -c 'adb pair <phone-ip>:<pair-port> && adb connect <phone-ip>:<port> && adb install -r app/build/outputs/apk/debug/app-debug.apk'
```

## Removing it all

```sh
colima delete android --data   # deletes the VM, image and volumes
rm -rf /Volumes/WD1TB/colima-android
```
