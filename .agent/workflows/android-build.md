---
description: How to build and install Android APK
---

# Android Build Workflow

## Prerequisites
- Android SDK installed at `%LOCALAPPDATA%\Android\Sdk`
- Device connected via USB with USB debugging enabled

## Steps

### 1. Prebuild (only needed after changes to app.json or plugins)

> ⚠️ **CRITICAL**: Never use `npx expo prebuild` directly. Always use npm scripts.

// turbo
```bash
npm run prebuild:clean
```

This ensures `local.properties` is regenerated with the correct Android SDK path.

### 2. Build Release APK

// turbo
```powershell
cd android; .\gradlew.bat assembleRelease; cd ..
```

### 3. Install on Device

// turbo
```powershell
& "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe" install -r android/app/build/outputs/apk/release/app-release.apk
```

### Quick One-Liner (Build + Install)

// turbo
```powershell
cd android; .\gradlew.bat assembleRelease; cd ..; & "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe" install -r android/app/build/outputs/apk/release/app-release.apk
```

## Troubleshooting

### "SDK location not found" Error
Run `npm run prebuild` to regenerate `android/local.properties`.

### Build Failures After Plugin Changes
Run `npm run prebuild:clean` to regenerate the entire android folder.
