#!/usr/bin/env bash
# install-chrome-headless.sh
# Description: Installs required system libraries for running headless Chrome/Chromium on a VPS
#              Adds Google's Chrome apt repo and installs google-chrome-stable.
#              Verifies installation and falls back to installing snap chromium if necessary.
# Date: 04/12/2025 (UK format)
#
# Usage:
#   chmod +x install-chrome-headless.sh
#   sudo ./install-chrome-headless.sh
#
# Notes:
# - This script is written to be safe on modern Ubuntu/Debian servers.
# - It installs only the minimal libraries required for headless Chrome to run.
# - If your VPS architecture is not amd64, change/remove the repo step accordingly.

set -euo pipefail

echo "Updating apt package lists..."
sudo apt-get update -y

echo "Installing common dependencies required by Chrome/Chromium..."
sudo apt-get install -y --no-install-recommends \
  ca-certificates \
  fonts-liberation \
  libnss3 \
  lsb-release \
  xdg-utils \
  wget \
  gnupg \
  apt-transport-https \
  libxss1 \
  libasound2 \
  libatk1.0-0 \
  libatk-bridge2.0-0 \
  libcups2 \
  libx11-6 \
  libx11-xcb1 \
  libxcb1 \
  libxcomposite1 \
  libxdamage1 \
  libxrandr2 \
  libgbm1 \
  libgdk-pixbuf2.0-0 \
  libgtk-3-0 \
  libpango-1.0-0 \
  libpangocairo-1.0-0 \
  libstdc++6 \
  fonts-noto-color-emoji || true

# Add Google Chrome's apt repository and install Chrome.
echo "Adding Google Chrome apt repository..."
wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | sudo gpg --dearmor -o /usr/share/keyrings/google-linux-signing-keyring.gpg
echo "deb [signed-by=/usr/share/keyrings/google-linux-signing-keyring.gpg arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" | \
  sudo tee /etc/apt/sources.list.d/google-chrome.list > /dev/null

echo "Updating apt again with Google repo..."
sudo apt-get update -y

echo "Installing google-chrome-stable..."
# Try to install google-chrome-stable. If it fails (non-amd64 or repo issues), we will try snap fallback.
if sudo apt-get install -y google-chrome-stable; then
  echo "google-chrome-stable installed."
else
  echo "Failed to install google-chrome-stable via apt. Will attempt snap (chromium) fallback."
  # Try snap fallback if snapd is available/works on your VPS
  if command -v snap >/dev/null 2>&1; then
    sudo snap install chromium --classic || true
  else
    echo "snap not available on this system. Please install snapd or install a compatible Chromium/Chrome manually."
  fi
fi

echo "Verifying installed browser binaries..."
if command -v google-chrome-stable >/dev/null 2>&1; then
  /usr/bin/google-chrome-stable --version || true
elif command -v google-chrome >/dev/null 2>&1; then
  google-chrome --version || true
elif command -v chromium-browser >/dev/null 2>&1; then
  chromium-browser --version || true
elif command -v chromium >/dev/null 2>&1; then
  chromium --version || true
else
  echo "No chrome/chromium binary found after installation. Check above output for errors."
fi

echo "Done. If you plan to run Puppeteer, install puppeteer-core and point executablePath to the binary above."
