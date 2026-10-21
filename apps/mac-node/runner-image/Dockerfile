# Build runner for Renki Mac build jobs (see ../README.md). Runs inside a
# dedicated Colima VM with no folders shared from the Mac, as an unprivileged
# user with no capabilities, behind the VM's egress firewall.
#
# arm64 image; Android's Linux host tools (aapt2, NDK clang, CMake) are x86_64
# only, so their x86_64 libraries are installed too and Rosetta runs them.
FROM node:22-bookworm-slim

RUN dpkg --add-architecture amd64 \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      openjdk-17-jdk-headless git unzip curl ca-certificates python3 \
      libc6:amd64 libstdc++6:amd64 zlib1g:amd64 libtinfo6:amd64 \
 && rm -rf /var/lib/apt/lists/*

# Android command-line tools. The SDK itself lives in the runner's home volume
# (seeded from here on first start), so Gradle can add the platforms, build
# tools, NDK and CMake a project asks for, and they survive the container.
ARG CMDLINE_TOOLS=https://dl.google.com/android/repository/commandlinetools-linux-13114758_latest.zip
RUN mkdir -p /opt/android-cmdline-tools \
 && curl -fsSL "$CMDLINE_TOOLS" -o /tmp/tools.zip \
 && unzip -q /tmp/tools.zip -d /opt/android-cmdline-tools \
 && mv /opt/android-cmdline-tools/cmdline-tools /opt/android-cmdline-tools/latest \
 && rm /tmp/tools.zip

# ESP-IDF, for ESP32 firmware jobs: the same version as on the Mac, tools for
# the esp32s3 only to keep the image small. Jobs run `. /opt/esp-idf/export.sh`
# first. Builds here are unsigned; the Mac signs app images with the user's key
# afterwards (signEspImages), which never enters this VM.
ARG IDF_VERSION=v5.5.6
RUN apt-get update \
 && apt-get install -y --no-install-recommends cmake ninja-build python3-venv python3-pip libusb-1.0-0 flex bison gperf wget ccache \
 && rm -rf /var/lib/apt/lists/* \
 && git config --system --add safe.directory '*' \
 && git clone -q --depth 1 -b "$IDF_VERSION" --recursive --shallow-submodules https://github.com/espressif/esp-idf.git /opt/esp-idf \
 && IDF_TOOLS_PATH=/opt/espressif /opt/esp-idf/install.sh esp32s3 \
 && rm -rf /opt/espressif/dist \
 && chmod -R a+rX /opt/esp-idf /opt/espressif

# The runner user: no sudo, no password. Its home is the persistent volume.
RUN usermod -l runner -d /home/runner -m node && groupmod -n runner node \
 && mkdir -p /home/runner/work && chown -R 1000:1000 /home/runner

# Read by renki-runner.mjs (it hands jobs a clean environment plus these).
RUN printf '%s\n' \
      "JAVA_HOME=$(dirname $(dirname $(readlink -f $(which javac))))" \
      "ANDROID_HOME=/home/runner/android-sdk" \
      "ANDROID_SDK_ROOT=/home/runner/android-sdk" \
      "GRADLE_USER_HOME=/home/runner/.gradle" \
      "npm_config_cache=/home/runner/.npm" \
      "GRADLE_OPTS=-Dorg.gradle.daemon.idletimeout=1800000" \
      "IDF_TOOLS_PATH=/opt/espressif" \
      "IDF_CCACHE_ENABLE=1" \
      "CCACHE_DIR=/home/runner/.ccache" \
      > /etc/renki-runner-env

COPY renki-runner.mjs /opt/renki/renki-runner.mjs
COPY renki-linux-arm64.gradle /opt/renki/init.d/renki-linux-arm64.gradle
USER 1000:1000
WORKDIR /home/runner
CMD ["sleep", "infinity"]
