# Android build environment (SDK, NDK, CMake, adb) for the native Pad Games app.
# x86_64 only: Google ships the Linux NDK and aapt2 for x86_64, so on Apple Silicon this
# runs under Rosetta in the "android" Colima profile. See android/README.md.
FROM --platform=linux/amd64 eclipse-temurin:17-jdk-jammy

RUN apt-get update \
 && apt-get install -y --no-install-recommends unzip curl git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ENV ANDROID_HOME=/opt/android-sdk
ENV PATH=$PATH:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools

ARG CMDLINE_TOOLS=13114758
RUN mkdir -p $ANDROID_HOME/cmdline-tools \
 && curl -fsSL -o /tmp/tools.zip https://dl.google.com/android/repository/commandlinetools-linux-${CMDLINE_TOOLS}_latest.zip \
 && unzip -q /tmp/tools.zip -d /tmp/tools \
 && mv /tmp/tools/cmdline-tools $ANDROID_HOME/cmdline-tools/latest \
 && rm -rf /tmp/tools /tmp/tools.zip

ARG PLATFORM=android-36
ARG BUILD_TOOLS=36.0.0
ARG NDK=28.2.13676358
ARG CMAKE=3.22.1
RUN yes | sdkmanager --licenses >/dev/null \
 && sdkmanager --install "platform-tools" "platforms;${PLATFORM}" "build-tools;${BUILD_TOOLS}" \
      "ndk;${NDK}" "cmake;${CMAKE}" >/dev/null \
 && rm -rf /root/.android/cache

ENV ANDROID_NDK_HOME=$ANDROID_HOME/ndk/$NDK
WORKDIR /work/android
