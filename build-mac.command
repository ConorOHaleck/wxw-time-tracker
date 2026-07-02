#!/bin/bash
# Double-click this file in Finder to build WxW Time Tracker for macOS.
# It runs everything for you and opens the folder with the finished installer.

cd "$(dirname "$0")" || exit 1
clear
echo "================================================"
echo "   Building WxW Time Tracker for macOS"
echo "================================================"
echo

# Check that Node.js is installed.
if ! command -v npm >/dev/null 2>&1; then
  echo "Node.js isn't installed yet — it's needed to build the app (one-time)."
  echo
  echo "  1. Go to   https://nodejs.org"
  echo "  2. Download the macOS installer (the big green 'LTS' button)"
  echo "  3. Open the downloaded file and click Continue / Install"
  echo "  4. Then double-click this build file again."
  echo
  read -r -p "Press Return to close this window."
  exit 1
fi

echo "Step 1 of 2:  Getting things ready (this can take a minute)..."
echo
if ! npm install; then
  echo
  echo "Setup didn't finish. Please try again, or send this whole window to support."
  read -r -p "Press Return to close this window."
  exit 1
fi

echo
echo "Step 2 of 2:  Building the app..."
echo
if ! npm run dist:mac; then
  echo
  echo "The build didn't finish. Please try again, or send this whole window to support."
  read -r -p "Press Return to close this window."
  exit 1
fi

echo
echo "================================================"
echo "   Done!  Your installer is the .dmg file"
echo "   in the 'dist' folder that just opened."
echo "================================================"
open dist
echo
read -r -p "Press Return to close this window."
