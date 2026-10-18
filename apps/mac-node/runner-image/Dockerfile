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
      > /etc/renki-runner-env

COPY renki-runner.mjs /opt/renki/renki-runner.mjs
USER 1000:1000
WORKDIR /home/runner
CMD ["sleep", "infinity"]
